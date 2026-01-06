# OHIF-AI Lambda Labs GPU Server Setup Guide

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Initial Setup on Lambda Labs](#initial-setup-on-lambda-labs)
3. [Code Changes Made](#code-changes-made)
4. [Server Configuration](#server-configuration)
5. [Client Configuration](#client-configuration)
6. [Setting Up a New Instance](#setting-up-a-new-instance)
7. [Troubleshooting](#troubleshooting)
8. [Cost Management](#cost-management)

---

## Architecture Overview

This project uses a **split deployment architecture**:

```
┌─────────────────────┐              ┌──────────────────────┐
│   Local Machine     │              │   Lambda Labs A10    │
│                     │              │                      │
│  ┌───────────────┐  │   API calls  │  ┌────────────────┐  │
│  │ OHIF Viewer   │  │─────────────>│  │ MONAI Label    │  │
│  │ (React/Node)  │  │              │  │ API Server     │  │
│  │               │  │              │  │ (GPU-powered)  │  │
│  │ - UI          │  │              │  │                │  │
│  │ - DICOM files │  │              │  │ - SAM2/MedSAM2 │  │
│  └───────────────┘  │              │  │ - nnInteractive│  │
│                     │              │  └────────────────┘  │
│  Port: 3000 (local) │              │  Port: 8002          │
└─────────────────────┘              └──────────────────────┘
```

**Why this architecture?**
- **Cost efficiency**: Only pay for GPU when running inference
- **Security**: Medical images stay on local machine
- **Performance**: GPU-accelerated inference on A10 (24GB VRAM)
- **Flexibility**: Can switch GPU instances as needed

---

## Initial Setup on Lambda Labs

### Step 1: Create Lambda Labs Account

1. Go to https://lambdalabs.com/service/gpu-cloud
2. Create an account
3. Add payment method
4. Add SSH key:
   ```bash
   # On your local machine (if you don't have an SSH key)
   ssh-keygen -t ed25519 -C "your_email@example.com"
   cat ~/.ssh/id_ed25519.pub
   # Copy this public key
   ```

### Step 2: Launch GPU Instance

1. Go to **Instances** tab
2. Click **Launch Instance**
3. Select **1x A10 (24 GB)** - ~$0.60/hour
4. Choose **Ubuntu 22.04** (comes with CUDA pre-installed)
5. Select region closest to you
6. Paste your SSH public key
7. Click **Launch**
8. Note the assigned IP address (e.g., `129.213.144.179`)

### Step 3: Connect to Instance

```bash
ssh ubuntu@YOUR_INSTANCE_IP
# Example: ssh ubuntu@129.213.144.179
```

### Step 4: Verify Environment

Lambda Labs instances come with Docker and NVIDIA drivers pre-installed. Verify:

```bash
# Check Docker
docker --version
docker compose version

# Check GPU
nvidia-smi

# Test GPU in Docker
sudo docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi
```

Expected output:
- Docker 28.5.1+
- NVIDIA Driver 570.195.03
- CUDA 12.8
- GPU: NVIDIA A10 (24GB)

---

## Code Changes Made

### 1. Created `docker-compose.server.yml`

**File:** `/home/ubuntu/OHIF-AI/docker-compose.server.yml`

**Purpose:** Server-only deployment without OHIF viewer and Orthanc dependencies.

**Key differences from original `docker-compose.yml`:**

| Aspect | Original | Server-Only |
|--------|----------|-------------|
| Services | 3 (ohif_viewer, orthanc, monai_sam2) | 1 (monai_sam2) |
| Dependencies | monai depends on ohif + orthanc | No dependencies |
| Studies source | `http://orthanc:8042/dicom-web` | `/code/studies` (local folder) |
| Runtime | `runtime: nvidia` | `deploy.resources.reservations` |

**Full file content:**

```yaml
services:
  monai_sam2:
    build:
      context: ./
      dockerfile: ./monai-label/Dockerfile
    image: monai
    container_name: monai_sam2
    volumes:
      - ./monai-label/predictions:/code/predictions
      - ./monai-label/studies:/code/studies
    environment:
      - CUDA_VISIBLE_DEVICES=0
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=all
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              capabilities: [gpu]
    shm_size: '10gb'
    ports:
      - '8002:8002'
    restart: on-failure
    command: >
      python -m monailabel.main start_server
      --app /code/apps/radiology
      --studies /code/studies
      --conf models segmentation
      --conf use_pretrained_model false
      -p 8002
```

**Why these changes?**

1. **Removed `runtime: nvidia`**: Lambda Labs Docker uses newer GPU access method
2. **Local studies folder**: No Orthanc needed - images sent directly via API
3. **No dependencies**: Can start independently
4. **Explicit GPU allocation**: Using `deploy.resources.reservations` for GPU access

### 2. Created Directory Structure

```bash
mkdir -p /home/ubuntu/OHIF-AI/monai-label/predictions
mkdir -p /home/ubuntu/OHIF-AI/monai-label/studies
```

**Purpose:**
- `predictions/`: Stores inference results
- `studies/`: Empty folder for MONAI server requirement (images sent via API)

**Note:** These directories are in `.gitignore` - they're runtime folders, not tracked.

---

## Server Configuration

### Building and Starting the Server

```bash
cd /home/ubuntu/OHIF-AI

# Build the Docker image (first time: 15-20 minutes)
sudo docker compose -f docker-compose.server.yml up --build -d

# Monitor build progress
sudo docker compose -f docker-compose.server.yml logs -f

# Wait for this message:
# "Uvicorn running on http://0.0.0.0:8002"
```

**What happens during build:**
1. Downloads NVIDIA CUDA 12.1.1 base image (~3GB)
2. Installs Python dependencies (PyTorch, MONAI, transformers)
3. Downloads model weights:
   - SAM2.1 Hiera Tiny (~130MB)
   - MedSAM2 (~1.3GB)
4. Downloads radiology app from MONAI registry

**Build artifacts cached** - subsequent builds are much faster.

### Verify Server is Running

```bash
# Check container status
sudo docker compose -f docker-compose.server.yml ps

# Should show:
# NAME         STATUS       PORTS
# monai_sam2   Up X mins    0.0.0.0:8002->8002/tcp

# Test API
curl http://localhost:8002/info/

# Should return JSON with available models
```

### Verify GPU Access

```bash
sudo docker exec monai_sam2 nvidia-smi

# Should show:
# GPU 0: NVIDIA A10
# Memory Usage: ~1400MiB (model weights loaded)
# Process: python (MONAI server)
```

### Available Models

| Model | Description | Use Case |
|-------|-------------|----------|
| `segmentation` | Multi-organ segmentation | CT scans (40+ organs) |
| `Histogram+GraphCut` | Scribble-based | Interactive refinement |
| `GMM+GraphCut` | Gaussian Mixture Model | Interactive segmentation |

**Supported organs:** Spleen, kidneys, liver, lungs, heart, gallbladder, pancreas, aorta, esophagus, trachea, and more.

---

## Client Configuration

### Option A: Direct IP Access (Simple)

**1. Configure Lambda Labs Firewall:**

1. Go to https://cloud.lambdalabs.com/instances
2. Click on your instance
3. Find **Firewall** section
4. Add rule:
   - Port: `8002`
   - Protocol: `TCP`
   - Source: `0.0.0.0/0` (or your IP for security)

**2. Configure OHIF (on your local machine):**

Edit these files in your local OHIF repository:

**File:** `Viewers/extensions/monai-label/src/components/SettingsTable.tsx`

```typescript
// Line 20: Change default server URL
const defaultServerURL = 'http://129.213.144.179:8002/'; // Replace with your Lambda IP

// Line 109: Change fallback
const fallbackURL = 'http://129.213.144.179:8002'; // Replace with your Lambda IP
```

**File:** `Viewers/extensions/monai-label/src/panels/MonaiLabelPanel.tsx`

```typescript
// Line 109: Change fallback
const fallbackURL = 'http://129.213.144.179:8002'; // Replace with your Lambda IP
```

**3. Build and run OHIF locally:**

```bash
cd Viewers
yarn install
yarn dev
```

Access at: `http://localhost:3000`

### Option B: SSH Tunnel (More Secure)

**1. No firewall changes needed**

**2. Create SSH tunnel (on local machine):**

```bash
ssh -L 8002:localhost:8002 ubuntu@129.213.144.179
# Keep this terminal open
```

**3. Configure OHIF to use localhost:**

Edit the same files as Option A, but use `http://localhost:8002` instead of the Lambda IP.

**4. Build and run OHIF:**

```bash
cd Viewers
yarn install
yarn dev
```

**Advantages of SSH tunnel:**
- ✅ Encrypted traffic
- ✅ No firewall configuration
- ✅ Works from any network
- ❌ Must keep SSH connection alive

---

## Setting Up a New Instance

If your Lambda Labs instance is terminated or you need to redeploy:

### Quick Setup (5 minutes)

```bash
# 1. SSH into new instance
ssh ubuntu@NEW_INSTANCE_IP

# 2. Clone repository
git clone https://github.com/anandpreshob/OHIF-AI.git
cd OHIF-AI

# 3. Create required directories
mkdir -p monai-label/predictions monai-label/studies

# 4. Build and start (uses cached layers if available)
sudo docker compose -f docker-compose.server.yml up --build -d

# 5. Monitor startup
sudo docker compose -f docker-compose.server.yml logs -f

# 6. Test when ready
curl http://localhost:8002/info/
```

### Update Client Configuration

Update the IP address in your local OHIF:

```typescript
// SettingsTable.tsx line 20 & 109
// MonaiLabelPanel.tsx line 109
const serverURL = 'http://NEW_INSTANCE_IP:8002/';
```

### Using Persistent Volumes (Advanced)

To avoid re-downloading models:

1. **Save model weights:**
   ```bash
   # Before terminating old instance
   sudo docker cp monai_sam2:/code/checkpoints ./checkpoints-backup
   ```

2. **On new instance:**
   ```bash
   # Copy checkpoints back
   mkdir -p monai-label/checkpoints
   # Upload via scp or rsync
   ```

3. **Mount in docker-compose.server.yml:**
   ```yaml
   volumes:
     - ./monai-label/predictions:/code/predictions
     - ./monai-label/studies:/code/studies
     - ./monai-label/checkpoints:/code/checkpoints  # Add this
   ```

---

## Troubleshooting

### Server won't start

**Check logs:**
```bash
sudo docker compose -f docker-compose.server.yml logs
```

**Common issues:**

| Error | Cause | Solution |
|-------|-------|----------|
| `unknown runtime: nvidia` | Using old runtime syntax | Already fixed in server config |
| `Out of memory` | Model too large for GPU | Use smaller model or upgrade GPU |
| `Port 8002 already in use` | Another process using port | `sudo lsof -i :8002` and kill process |
| `GPU not found` | GPU not allocated | Check `nvidia-smi` and deploy config |

### API returns 404

```bash
# Check if trailing slash is needed
curl http://localhost:8002/info   # Redirects
curl http://localhost:8002/info/  # Works

# OHIF should use trailing slash
```

### Client can't connect

**Test connectivity:**
```bash
# From local machine
curl http://LAMBDA_IP:8002/info/

# If timeout:
# - Check firewall rules
# - Verify server is running: sudo docker compose -f docker-compose.server.yml ps
# - Check Lambda instance is running
```

**CORS issues:**

Server is configured with `Allow Origins: ['*']` - should work from any domain.

### GPU not being used

```bash
# Check GPU allocation
sudo docker exec monai_sam2 nvidia-smi

# Should show:
# - GPU 0: NVIDIA A10
# - Memory Usage: ~1400MiB
# - Process: python

# If GPU shows 0MiB:
# 1. Restart container
sudo docker compose -f docker-compose.server.yml restart

# 2. Check environment variables
sudo docker exec monai_sam2 env | grep CUDA
```

### Slow inference

**Check GPU utilization:**
```bash
watch -n 1 sudo docker exec monai_sam2 nvidia-smi

# During inference, GPU-Util should spike to 80-100%
```

**Possible causes:**
- Images too large (resize before sending)
- CPU fallback (check GPU is detected)
- Network latency (use SSH tunnel)

---

## Cost Management

Lambda Labs charges **$0.60/hour** for A10 instances.

### Stop server when not in use:

```bash
# Stop containers (keeps instance running)
sudo docker compose -f docker-compose.server.yml down

# Start again
sudo docker compose -f docker-compose.server.yml up -d
```

### Terminate instance completely:

1. Go to https://cloud.lambdalabs.com/instances
2. Click on instance
3. Click **Terminate**

**Important:** All data is lost when instance terminates. Save any important files first.

### Auto-shutdown script (optional)

```bash
# Create a script to auto-shutdown after 2 hours of inactivity
cat > ~/auto-shutdown.sh << 'EOF'
#!/bin/bash
IDLE_TIME=7200  # 2 hours in seconds
while true; do
  ACTIVITY=$(docker stats --no-stream --format "{{.CPUPerc}}" monai_sam2 2>/dev/null | sed 's/%//')
  if (( $(echo "$ACTIVITY < 1" | bc -l) )); then
    echo "Shutting down due to inactivity"
    sudo docker compose -f ~/OHIF-AI/docker-compose.server.yml down
    break
  fi
  sleep 60
done
EOF
chmod +x ~/auto-shutdown.sh
```

---

## Server Management Commands

### Daily Operations

```bash
# Start server
sudo docker compose -f docker-compose.server.yml up -d

# Stop server
sudo docker compose -f docker-compose.server.yml down

# Restart server
sudo docker compose -f docker-compose.server.yml restart

# View logs (real-time)
sudo docker compose -f docker-compose.server.yml logs -f

# View last 100 lines
sudo docker compose -f docker-compose.server.yml logs --tail=100

# Check status
sudo docker compose -f docker-compose.server.yml ps

# Check GPU usage
sudo docker exec monai_sam2 nvidia-smi

# Test API
curl http://localhost:8002/info/
```

### Rebuilding

```bash
# Rebuild after code changes
sudo docker compose -f docker-compose.server.yml up --build -d

# Force rebuild (ignore cache)
sudo docker compose -f docker-compose.server.yml build --no-cache
sudo docker compose -f docker-compose.server.yml up -d

# Clean everything and rebuild
sudo docker compose -f docker-compose.server.yml down
sudo docker system prune -a -f
sudo docker compose -f docker-compose.server.yml up --build -d
```

### Debugging

```bash
# Enter container shell
sudo docker exec -it monai_sam2 bash

# Inside container:
ls /code/checkpoints/        # Check model weights
python -m monailabel.main apps  # List apps
nvidia-smi                    # Check GPU
exit

# Check container resource usage
sudo docker stats monai_sam2

# Check disk usage
sudo docker system df
```

---

## API Endpoints Reference

### Base URL
- **Local:** `http://localhost:8002`
- **Remote:** `http://YOUR_LAMBDA_IP:8002`

### Available Endpoints

| Endpoint | Method | Description | Example |
|----------|--------|-------------|---------|
| `/info/` | GET | Server and model info | `curl http://localhost:8002/info/` |
| `/infer/segmentation` | POST | Run segmentation | Multipart form with image |
| `/model/` | GET | List available models | `curl http://localhost:8002/model/` |
| `/datastore/` | GET | List studies | `curl http://localhost:8002/datastore/` |

### Example API call:

```bash
# Get server info
curl -s http://localhost:8002/info/ | python3 -m json.tool

# Expected response includes:
# - name: "MONAILabel - Radiology"
# - version
# - models: ["segmentation"]
# - labels: {organ names and IDs}
```

---

## Summary Checklist

### Initial Setup
- [ ] Lambda Labs account created
- [ ] SSH key added
- [ ] A10 instance launched
- [ ] Connected via SSH
- [ ] Repository cloned
- [ ] Directories created
- [ ] Docker image built
- [ ] Server running on port 8002
- [ ] API responding to `/info/` requests
- [ ] GPU detected and in use

### Client Setup
- [ ] Firewall configured (if using direct IP) OR SSH tunnel active
- [ ] OHIF code updated with server IP
- [ ] OHIF built and running locally
- [ ] Successfully connected to MONAI API from OHIF

### Production Checklist
- [ ] Server auto-restart configured (`restart: on-failure`)
- [ ] Monitoring set up (optional)
- [ ] Backup strategy for model weights (optional)
- [ ] Auto-shutdown configured (optional)
- [ ] Team has access credentials

---

## Additional Resources

- **MONAI Label Docs:** https://docs.monailabel.org/
- **Lambda Labs Docs:** https://lambdalabs.com/blog
- **OHIF Viewer Docs:** https://docs.ohif.org/
- **Repository:** https://github.com/anandpreshob/OHIF-AI

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-05 | Initial Lambda Labs deployment setup | anandpreshob |
| 2026-01-05 | Created docker-compose.server.yml for GPU-only deployment | Claude Code |
| 2026-01-05 | Removed runtime: nvidia, using deploy.resources | Claude Code |
| 2026-01-05 | Documented complete setup process | Claude Code |

---

**Note:** This setup was tested on Lambda Labs A10 instance (24GB VRAM) with Ubuntu 22.04, Docker 28.5.1, and NVIDIA Driver 570.195.03. Minor adjustments may be needed for different GPU types or configurations.
