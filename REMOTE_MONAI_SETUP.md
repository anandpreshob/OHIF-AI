# Remote MONAI Label Server Setup

This document describes how to configure the OHIF-AI viewer to connect to a remote MONAI Label server running on a GPU instance.

## Quick Start: Changing the MONAI Server IP

When you spin up a new GPU instance, you only need to update **one file**:

### Edit `docker-compose.yml`

Open `docker-compose.yml` and find the MONAI configuration section at the top:

```yaml
# ============================================================================
# MONAI Label Server Configuration
# ============================================================================
x-monai-config: &monai-config
  MONAI_SERVER_HOST: 129.213.144.179  # <-- Change this IP address
  MONAI_SERVER_PORT: 8002              # <-- Change port if needed
# ============================================================================
```

Then restart the containers:

```bash
docker-compose down
docker-compose up -d
```

The nginx configuration will automatically pick up the new IP address on startup.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Local Docker Host                             │
│  ┌─────────────────┐    ┌───────────────┐    ┌──────────────────┐   │
│  │   OHIF Viewer   │────│     Nginx     │────│     Orthanc      │   │
│  │   (Frontend)    │    │   (Reverse    │    │   (DICOM PACS)   │   │
│  │   Port 1026     │    │    Proxy)     │    │   Port 8042      │   │
│  └─────────────────┘    └───────┬───────┘    └──────────────────┘   │
│                                 │                                    │
└─────────────────────────────────┼────────────────────────────────────┘
                                  │
                                  │ /monai/* proxy
                                  │
                    ┌─────────────▼─────────────┐
                    │   Remote GPU Instance      │
                    │  ┌─────────────────────┐   │
                    │  │   MONAI Label       │   │
                    │  │   Server            │   │
                    │  │   Port 8002         │   │
                    │  │                     │   │
                    │  │   Models:           │   │
                    │  │   - segmentation    │   │
                    │  │     (SAM3/nninter)  │   │
                    │  └─────────────────────┘   │
                    │   IP: 129.213.144.179      │
                    └───────────────────────────┘
```

## Technical Changes Made

The following changes were made to enable remote MONAI Label server connectivity:

### 1. Nginx Reverse Proxy Configuration

**Files Modified:**
- `Viewers/platform/app/.recipes/Nginx-Orthanc/config/nginx.conf.template` (new)
- `Viewers/platform/app/.recipes/Nginx-Orthanc/config/docker-entrypoint.sh` (new)

The nginx configuration now uses environment variables for the MONAI server address:
- `MONAI_SERVER_HOST` - IP address or hostname
- `MONAI_SERVER_PORT` - Port number (default: 8002)

The `docker-entrypoint.sh` script uses `envsubst` to substitute these variables at container startup.

### 2. Client-Side Changes

**File: `Viewers/extensions/default/src/commandsModule.ts`**

- Modified `postToMonaiWithImageId()` to upload DICOM files directly to the server
- The MONAI server does not support `?image=` query parameters; it requires file uploads
- Changed `nninter: true` to `nninter: "sam3"` for proper SAM3 mode activation
- Fixed `flipped` boolean handling (server returns `true`/`false`, not strings)
- Added `parseNifti()` call to properly extract voxels from NIfTI responses

**File: `Viewers/extensions/default/src/utils/multipart.ts`**

- Added `parseNifti()` function to parse NIfTI-1 format segmentation results
- Modified `parseMultipart()` to accept both client and server field naming conventions:
  - Server sends: `params` + `image`
  - Client expected: `meta` + `seg`
- Fixed gzip detection to check both `Content-Encoding` and `Content-Type` headers
- Added data transposition from server's [Z,Y,X] order to client's [X,Y,Z] slice-by-slice order

### 3. MONAI Label Client

**File: `monai-label/plugins/ohifv3/extensions/monai-label/src/services/MonaiLabelClient.js`**

- Added `lookupSeriesId()` to find Orthanc series ID from SeriesInstanceUID
- Added `downloadSeriesArchive()` to fetch DICOM as ZIP
- Added `fetchDicomSeries()` to orchestrate the fetch process
- Modified `infer()` to upload DICOM files via FormData instead of using query parameters

## MONAI Label Server API

The server exposes a single `segmentation` model with multiple modes controlled by the `nninter` parameter:

### Inference Request

```bash
POST /infer/segmentation?output=all
Content-Type: multipart/form-data

# Form fields:
file: <ZIP file containing DICOM series>
params: {"nninter": "sam3", "pos_points": [[x, y, z]], "neg_points": []}
```

### `nninter` Parameter Values

| Value    | Description                                          |
|----------|------------------------------------------------------|
| `"init"` | Initialize a new session (resets internal state)     |
| `"sam3"` | Run SAM3 inference with provided prompts             |
| `"reset"`| Reset the current segmentation                       |

### Response Format

The server returns a multipart response:

```
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="params"
Content-Type: application/json

{"label_names": {"1": "segment1"}, "flipped": true, ...}
--boundary
Content-Disposition: form-data; name="image"
Content-Type: application/gzip

<gzipped NIfTI-1 format segmentation>
--boundary--
```

### NIfTI Data Format Notes

- The server returns NIfTI-1 format with a 348-byte header
- Voxel data starts at byte offset 352 (or value in `vox_offset` field)
- **Important:** Server dimensions are [Z, Y, X] but client expects [X, Y, Z]
- The client automatically transposes the data to match the expected format

## Troubleshooting

### Common Issues

1. **500 Error on Inference**
   - Ensure the MONAI server is running and accessible
   - Check that the IP address is correct in `docker-compose.yml`
   - Verify the server can receive file uploads (check server logs)

2. **"meta part not found" Error**
   - This was fixed by accepting both `params`/`image` and `meta`/`seg` field names

3. **Segmentation Shows Diagonal Lines or Boxes**
   - This was fixed by proper NIfTI parsing and data transposition
   - The fix handles the Z/Y/X to X/Y/Z coordinate transformation

4. **Connection Timeout**
   - Nginx is configured with 300s timeouts for inference operations
   - Check if the GPU server is overloaded

### Testing the Connection

You can test the MONAI server connectivity with:

```bash
# From the Docker host
curl -s http://<MONAI_IP>:8002/info/ | jq .

# Expected output includes:
# "models": {"segmentation": {...}}
```

### Checking Logs

```bash
# OHIF/Nginx logs
docker logs ohif_orthanc

# Look for:
# "Configuring OHIF Viewer..."
# "MONAI Server: <IP>:8002"
```

## Development Notes

### Building and Running

```bash
# Build containers
docker-compose build

# Start services
docker-compose up -d

# View logs
docker-compose logs -f ohif_viewer
```

### Key Files Reference

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Main configuration - contains MONAI server IP |
| `nginx.conf.template` | Nginx config template with environment variables |
| `docker-entrypoint.sh` | Substitutes env vars and starts nginx |
| `commandsModule.ts` | OHIF commands for segmentation |
| `multipart.ts` | Multipart response and NIfTI parsing |
| `MonaiLabelClient.js` | API client for MONAI Label server |

---

*Last updated: January 2026*
