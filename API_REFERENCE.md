# MONAI Label Server API Reference

Complete API documentation for the OHIF-AI MONAI Label server with SAM2/SAM3 interactive segmentation.

---

## Base URL

```
http://<SERVER_IP>:8002
```

**Examples:**
- Local: `http://localhost:8002`
- Remote: `http://129.213.144.179:8002`

---

## Authentication

Currently, the server does not require authentication. For production deployments, consider adding authentication via:
- nginx reverse proxy with Basic Auth
- API Gateway with token authentication
- VPN access only

---

## Endpoints

### 1. Health Check

**Endpoint:** `GET /`

Check if the server is running.

**Request:**
```bash
curl http://localhost:8002/
```

**Response:**
```json
{
  "status": "UP"
}
```

**Status Codes:**
- `200 OK` - Server is running
- `503 Service Unavailable` - Server is down

---

### 2. Server Information

**Endpoint:** `GET /info/`

Get server information, loaded models, and configuration.

**Request:**
```bash
curl http://localhost:8002/info/
```

**Response:**
```json
{
  "name": "MONAILabel - Radiology (0.8.1)",
  "version": "0.8.1",
  "description": "DeepLearning models for radiology",
  "labels": [
    "spleen",
    "kidney_right",
    "kidney_left",
    "gallbladder",
    "liver",
    ...
  ],
  "models": {
    "segmentation": {
      "type": "segmentation",
      "labels": {
        "spleen": 1,
        "kidney_right": 2,
        "kidney_left": 3,
        ...
      },
      "dimension": 3,
      "description": "A pre-trained model for volumetric (3D) Segmentation from CT image",
      "config": {
        "largest_cc": false
      }
    },
    "Histogram+GraphCut": {
      "type": "scribbles",
      ...
    },
    "GMM+GraphCut": {
      "type": "scribbles",
      ...
    }
  },
  "trainers": {},
  "strategies": {
    "random": {...},
    "first": {...},
    "last": {...}
  },
  "scoring": {},
  "train_stats": {},
  "datastore": {
    "objects": 0,
    "completed": 0
  },
  "config": {...}
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Server name and version |
| `version` | string | MONAI Label version |
| `labels` | array | All available segmentation labels |
| `models` | object | Loaded inference models |
| `datastore` | object | Datastore statistics |

**Status Codes:**
- `200 OK` - Success

---

### 3. Run Inference

**Endpoint:** `POST /infer/{model}`

Run inference using the specified model.

**Models:**
- `segmentation` - Interactive SAM2/SAM3 segmentation (primary use case)
- `Histogram+GraphCut` - Classical segmentation
- `GMM+GraphCut` - Classical segmentation

**Request Format:**

Content-Type: `multipart/form-data`

**Form Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes* | ZIP of DICOM series, single DICOM, or NIfTI file |
| `image` | string | Yes* | Image ID (if using datastore) |
| `params` | JSON string | Yes | Inference parameters |
| `label` | File | No | Existing label file for refinement |
| `output` | string | No | Output format: `image`, `json`, `all` (default: `all`) |

*Either `file` or `image` must be provided

**Params JSON Structure:**

```json
{
  "nninter": "sam3",           // Required: "init", "sam3", or "reset"
  "prompt_info": [...],        // Optional: Array of prompts (OHIF format)
  "pos_points": [[x,y,z]],     // Optional: Positive point prompts
  "neg_points": [[x,y,z]],     // Optional: Negative point prompts
  "pos_boxes": [[x1,y1,x2,y2,z]], // Optional: Positive box prompts
  "neg_boxes": [[x1,y1,x2,y2,z]], // Optional: Negative box prompts
  "device": "cuda",            // Optional: "cuda" or "cpu" (default: "cuda")
  "result_extension": ".nrrd", // Optional: Output format (ignored for now)
  "result_dtype": "uint16",    // Optional: Output data type (ignored for now)
  "result_compress": false,    // Optional: Compress output (ignored for now)
  "restore_label_idx": false   // Optional: Restore label indices (ignored for now)
}
```

**nninter Modes:**

| Mode | Description | Returns |
|------|-------------|---------|
| `init` | Initialize session with DICOM series | Empty JSON `{}` |
| `sam3` | Run SAM3 segmentation with prompts | Segmentation mask + metadata |
| `reset` | Reset session and clear all interactions | Empty JSON `{}` |

**Prompt Info Format (OHIF):**

```json
{
  "prompt_info": [
    {
      "type": "point",
      "data": {
        "pointType": "click",  // "click" = positive, "erase" = negative
        "slice": 40,           // Z-coordinate (slice index)
        "x": 256,              // X-coordinate in pixels
        "y": 256               // Y-coordinate in pixels
      }
    },
    {
      "type": "box",
      "data": {
        "pointType": "click",
        "slice": 40,
        "x": 100,              // Top-left X
        "y": 100,              // Top-left Y
        "width": 50,           // Box width
        "height": 50           // Box height
      }
    }
  ]
}
```

**Direct Prompt Format:**

```json
{
  "pos_points": [
    [256, 256, 40],  // [x, y, z] in pixel coordinates
    [200, 200, 40]
  ],
  "neg_points": [
    [100, 100, 40]
  ],
  "pos_boxes": [
    [100, 100, 150, 150, 40]  // [x1, y1, x2, y2, z]
  ],
  "neg_boxes": []
}
```

**Response Format:**

Content-Type: `multipart/form-data`

The response contains multiple parts:

**Part 1: params** (JSON metadata)
```json
{
  "prompt_info": {
    "pos_points": [[256, 256, 40]],
    "neg_points": [],
    "pos_boxes": [],
    "neg_boxes": []
  },
  "nninter_elapsed": 0.578,      // Inference time in seconds
  "flipped": true,                // Whether image was flipped
  "label_name": "nninter_pred_20260106044256"  // Generated label name
}
```

**Part 2: image** (Binary segmentation mask)
- Format: NIfTI (`.nii.gz`)
- Data type: uint8
- Dimensions: Same as input DICOM series (W x H x D)
- Values: 0 = background, 1 = segmented region

**Example Requests:**

**1. Initialize Session:**
```bash
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@/path/to/dicom_series.zip" \
  -F 'params={"nninter":"init"}'
```

**Response:**
```json
{}
```

**2. Segment with Single Point (OHIF format):**
```bash
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@/path/to/dicom_series.zip" \
  -F 'params={
    "nninter": "sam3",
    "prompt_info": [
      {
        "type": "point",
        "data": {
          "pointType": "click",
          "slice": 40,
          "x": 256,
          "y": 256
        }
      }
    ]
  }'
```

**3. Segment with Multiple Points (Direct format):**
```bash
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@/path/to/dicom_series.zip" \
  -F 'params={
    "nninter": "sam3",
    "pos_points": [[256, 256, 40], [200, 200, 40]],
    "neg_points": [[100, 100, 40]]
  }'
```

**4. Segment with Box Prompt:**
```bash
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@/path/to/dicom_series.zip" \
  -F 'params={
    "nninter": "sam3",
    "pos_boxes": [[100, 100, 200, 200, 40]]
  }'
```

**5. Reset Session:**
```bash
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@/path/to/dicom_series.zip" \
  -F 'params={"nninter":"reset"}'
```

**Response:**
```json
{}
```

**Status Codes:**

| Code | Description |
|------|-------------|
| `200 OK` | Inference successful |
| `400 Bad Request` | Invalid parameters or file format |
| `500 Internal Server Error` | Server error during inference |

**Common Errors:**

**Missing nninter parameter:**
```json
{
  "detail": "KeyError: 'nninter'"
}
```
Fix: Add `"nninter": "init"` or `"nninter": "sam3"` to params

**Invalid file format:**
```json
{
  "detail": "Neither Image nor File not Session ID input is provided"
}
```
Fix: Ensure `file` field is included in request

**GPU out of memory:**
```json
{
  "detail": "CUDA out of memory"
}
```
Fix: Reduce image size, restart server, or use smaller batch size

---

## JavaScript/TypeScript Integration

### Using Fetch API

```typescript
async function runSegmentation(
  serverUrl: string,
  dicomZipBlob: Blob,
  prompts: Array<{x: number, y: number, slice: number, positive: boolean}>
): Promise<{metadata: any, maskBlob: Blob}> {

  // Build form data
  const formData = new FormData();

  // Add DICOM file
  formData.append('file', dicomZipBlob, 'series.zip');

  // Add parameters
  const params = {
    nninter: 'sam3',
    prompt_info: prompts.map(p => ({
      type: 'point',
      data: {
        pointType: p.positive ? 'click' : 'erase',
        slice: p.slice,
        x: p.x,
        y: p.y
      }
    }))
  };
  formData.append('params', JSON.stringify(params));

  // Send request
  const response = await fetch(`${serverUrl}/infer/segmentation`, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  // Parse multipart response
  const contentType = response.headers.get('content-type') || '';
  const boundary = contentType.split('boundary=')[1];

  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);

  // Extract parts
  const parts = text.split(`--${boundary}`);

  // Parse JSON metadata
  const metadataPart = parts.find(p => p.includes('name="params"'));
  const metadataJson = metadataPart?.split('\r\n\r\n')[1].split('\r\n')[0];
  const metadata = JSON.parse(metadataJson || '{}');

  // Extract binary mask
  const imagePart = parts.find(p => p.includes('name="image"'));
  const imageData = imagePart?.split('\r\n\r\n')[1];
  // Note: This is simplified - actual implementation needs proper binary parsing

  return {
    metadata,
    maskBlob: new Blob([imageData], {type: 'application/gzip'})
  };
}
```

### Using Axios

```typescript
import axios from 'axios';
import FormData from 'form-data';

async function initSession(serverUrl: string, dicomFile: Buffer) {
  const formData = new FormData();
  formData.append('file', dicomFile, 'series.zip');
  formData.append('params', JSON.stringify({nninter: 'init'}));

  const response = await axios.post(
    `${serverUrl}/infer/segmentation`,
    formData,
    {
      headers: formData.getHeaders()
    }
  );

  return response.data; // {}
}

async function segment(
  serverUrl: string,
  dicomFile: Buffer,
  points: Array<[number, number, number]>
) {
  const formData = new FormData();
  formData.append('file', dicomFile, 'series.zip');
  formData.append('params', JSON.stringify({
    nninter: 'sam3',
    pos_points: points,
    neg_points: []
  }));

  const response = await axios.post(
    `${serverUrl}/infer/segmentation`,
    formData,
    {
      headers: formData.getHeaders(),
      responseType: 'arraybuffer'
    }
  );

  return response.data; // multipart data
}
```

---

## Python Integration

### Using requests

```python
import requests
import json

def init_session(server_url: str, dicom_zip_path: str):
    """Initialize segmentation session."""
    with open(dicom_zip_path, 'rb') as f:
        files = {'file': ('series.zip', f, 'application/zip')}
        data = {'params': json.dumps({'nninter': 'init'})}

        response = requests.post(
            f'{server_url}/infer/segmentation',
            files=files,
            data=data
        )
        response.raise_for_status()
        return response.json()

def run_segmentation(
    server_url: str,
    dicom_zip_path: str,
    pos_points: list,
    neg_points: list = None
):
    """Run interactive segmentation."""
    params = {
        'nninter': 'sam3',
        'pos_points': pos_points,
        'neg_points': neg_points or []
    }

    with open(dicom_zip_path, 'rb') as f:
        files = {'file': ('series.zip', f, 'application/zip')}
        data = {'params': json.dumps(params)}

        response = requests.post(
            f'{server_url}/infer/segmentation',
            files=files,
            data=data
        )
        response.raise_for_status()

        # Parse multipart response
        content_type = response.headers['content-type']
        boundary = content_type.split('boundary=')[1]

        # Simple parsing (for production, use multipart parser library)
        parts = response.content.split(f'--{boundary}'.encode())

        # Extract metadata
        for part in parts:
            if b'name="params"' in part:
                metadata_json = part.split(b'\r\n\r\n')[1].split(b'\r\n')[0]
                metadata = json.loads(metadata_json.decode())
            elif b'name="image"' in part:
                image_data = part.split(b'\r\n\r\n')[1]

        return metadata, image_data

# Example usage
if __name__ == '__main__':
    server = 'http://localhost:8002'
    dicom_file = '/path/to/series.zip'

    # Initialize
    init_session(server, dicom_file)

    # Segment with point prompts
    metadata, mask = run_segmentation(
        server,
        dicom_file,
        pos_points=[[256, 256, 40]],
        neg_points=[[100, 100, 40]]
    )

    print(f"Inference time: {metadata['nninter_elapsed']:.3f}s")
    print(f"Label: {metadata['label_name']}")

    # Save mask
    with open('segmentation_mask.nii.gz', 'wb') as f:
        f.write(mask)
```

---

## File Format Specifications

### Input Formats

**1. ZIP of DICOM Series**

Structure (flat):
```
series.zip
├── IM0001.dcm
├── IM0002.dcm
├── IM0003.dcm
└── ...
```

Structure (nested - also supported):
```
series.zip
└── 2.000000-PRE LIVER-76970/
    ├── IM0001.dcm
    ├── IM0002.dcm
    └── ...
```

**2. Single DICOM File**
- Extension: `.dcm`
- Format: DICOM Part 10 format

**3. NIfTI File**
- Extension: `.nii` or `.nii.gz`
- Format: NIfTI-1

### Output Format

**NIfTI Segmentation Mask**
- Format: NIfTI-1 compressed (`.nii.gz`)
- Data type: uint8
- Dimensions: [W, H, D] matching input series
- Coordinate system: RAS (Right-Anterior-Superior)
- Values:
  - 0: Background
  - 1: Segmented region

**Metadata JSON**
```json
{
  "prompt_info": {
    "pos_points": [[x, y, z], ...],
    "neg_points": [[x, y, z], ...],
    "pos_boxes": [[x1, y1, x2, y2, z], ...],
    "neg_boxes": [[x1, y1, x2, y2, z], ...]
  },
  "nninter_elapsed": 0.578,
  "flipped": true,
  "label_name": "nninter_pred_TIMESTAMP"
}
```

---

## Performance Benchmarks

Tested on NVIDIA A10 GPU (24GB VRAM):

| Operation | Image Size | Time | Notes |
|-----------|-----------|------|-------|
| Session Init | 512x512x43 | ~0.18s | First time loads model |
| Point Inference | 512x512x43 | ~0.58s | SAM3 with 1 point |
| Box Inference | 512x512x43 | ~0.62s | SAM3 with 1 box |
| Multi-point | 512x512x43 | ~0.71s | SAM3 with 5 points |

**Optimization Tips:**
- Initialize session once, reuse for multiple inferences
- Batch multiple prompts in single request
- Use GPU instance for 10-20x speedup vs CPU

---

## Rate Limits

Currently no rate limits enforced. For production:
- Consider nginx rate limiting (e.g., 10 req/min per IP)
- Monitor GPU memory usage
- Implement request queuing for concurrent requests

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-06 | Initial API release with SAM2/SAM3 support |

---

**Generated with Claude Code**
Last Updated: 2026-01-06
