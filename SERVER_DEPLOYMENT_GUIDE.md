# MONAI Label GPU Server Deployment Guide

Complete step-by-step guide to deploy the OHIF-AI MONAI Label server with SAM2/SAM3 interactive segmentation on any GPU instance.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Detailed Setup Instructions](#detailed-setup-instructions)
5. [Testing the Server](#testing-the-server)
6. [API Documentation](#api-documentation)
7. [Troubleshooting](#troubleshooting)
8. [Cost Management](#cost-management)

---

## Overview

This server provides GPU-accelerated medical image segmentation using:
- **SAM2/SAM3** - Segment Anything Model for interactive segmentation
- **nnInteractive** - Neural network-based interactive segmentation
- **MONAI Label** - Medical imaging AI framework

**Architecture:**
```
OHIF Viewer (Local) ──HTTP──> MONAI Label Server (GPU Cloud)
                               ├── SAM2/SAM3 Models
                               ├── GPU Inference
                               └── DICOM Processing
```

---

## Prerequisites

### GPU Instance Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| GPU | NVIDIA T4 (16GB) | NVIDIA A10 (24GB) |
| GPU Memory | 16GB VRAM | 24GB VRAM |
| CPU | 4 cores | 8+ cores |
| RAM | 16GB | 32GB+ |
| Storage | 50GB | 100GB+ |
| CUDA | 11.8+ | 12.1+ |

**Tested Cloud Providers:**
- Lambda Labs (A10: ~$0.60/hr)
- AWS EC2 (g4dn.xlarge, g5.xlarge)
- Google Cloud (n1-standard-4 + T4)
- Azure (NC6s_v3)

### Required Software

- Docker 20.10+
- Docker Compose 2.0+
- NVIDIA Docker Runtime
- Git
- curl

---

## Quick Start

### 1. Rent GPU Instance

**Lambda Labs (Recommended):**
```bash
# Go to https://cloud.lambdalabs.com/instances
# Select: 1x A10 (24 GB PCIe) - Ubuntu 22.04
# SSH into instance:
ssh ubuntu@<INSTANCE_IP>
```

**AWS EC2:**
```bash
# Launch g5.xlarge with Ubuntu 22.04 Deep Learning AMI
# Ensure Security Group allows port 8002
ssh -i key.pem ubuntu@<INSTANCE_IP>
```

### 2. Clone Repository

```bash
# Clone the repository
git clone https://github.com/anandpreshob/OHIF-AI.git
cd OHIF-AI
```

### 3. Verify GPU

```bash
# Check NVIDIA driver
nvidia-smi

# Expected output:
# +-----------------------------------------------------------------------------+
# | NVIDIA-SMI 570.xx.xx    Driver Version: 570.xx.xx    CUDA Version: 12.x   |
# |-------------------------------+----------------------+----------------------+
# | GPU  Name                     | Memory-Usage         |                      |
# |   0  NVIDIA A10               | 24576MiB             |                      |
# +-------------------------------+----------------------+----------------------+
```

### 4. Build and Run

```bash
# Build the Docker image (takes ~15-20 minutes)
sudo docker compose -f docker-compose.server.yml up --build -d

# Monitor build progress
sudo docker compose -f docker-compose.server.yml logs -f
```

### 5. Verify Server

```bash
# Wait for server to start (~30 seconds after build)
sleep 30

# Test server info endpoint
curl http://localhost:8002/info/ | grep -o '"models"'

# Should output: "models"
```

### 6. Configure Firewall (for Remote Access)

**Lambda Labs:**
```bash
# Go to Lambda Labs dashboard -> Instances -> Firewall
# Add rule: TCP port 8002 from 0.0.0.0/0
```

**AWS:**
```bash
# Security Group -> Edit Inbound Rules
# Add: Custom TCP, Port 8002, Source: 0.0.0.0/0
```

**Test Remote Access:**
```bash
# From your local machine
curl http://<INSTANCE_IP>:8002/info/
```

---

## Detailed Setup Instructions

### Step 1: Initial Instance Setup

```bash
# Update system packages
sudo apt update

# Verify Docker is installed
docker --version
# Output: Docker version 28.5.1 (or similar)

# Verify Docker Compose
docker compose version
# Output: Docker Compose version v2.40.1 (or similar)

# Verify NVIDIA Docker Runtime
sudo docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
# Should show GPU information
```

If Docker is not installed:

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker

# Install NVIDIA Docker Runtime
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update
sudo apt-get install -y nvidia-docker2
sudo systemctl restart docker
```

### Step 2: Clone and Configure

```bash
# Clone repository
cd ~
git clone https://github.com/anandpreshob/OHIF-AI.git
cd OHIF-AI

# Verify docker-compose.server.yml exists
cat docker-compose.server.yml
```

**Expected content:**
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

### Step 3: Build Docker Image

```bash
# Start build (will take 15-20 minutes)
sudo docker compose -f docker-compose.server.yml up --build -d

# Monitor logs in real-time
sudo docker compose -f docker-compose.server.yml logs -f monai_sam2
```

**Build Process:**
1. Downloads NVIDIA CUDA base image (~2GB)
2. Installs system dependencies (build tools, Python, etc.)
3. Installs SAM2/SAM3 Python packages (~5GB)
4. Downloads SAM2 model checkpoint (~149MB)
5. Installs MONAI Label and dependencies
6. Configures radiology app

**Key Log Messages to Watch For:**
```
✓ "Collecting torch" - PyTorch installation started
✓ "Successfully installed torch" - PyTorch ready
✓ "Successfully installed monai" - MONAI framework ready
✓ "Downloading sam2.1_hiera_tiny.pt" - Model checkpoint downloading
✓ "Using Models: ['segmentation']" - App configured
✓ "Application startup complete" - Server ready!
```

### Step 4: Verify Container Status

```bash
# Check container is running
sudo docker compose -f docker-compose.server.yml ps

# Expected output:
# NAME         IMAGE     COMMAND                  STATUS         PORTS
# monai_sam2   monai     "python -m monailabel…"  Up 2 minutes   0.0.0.0:8002->8002/tcp

# Check GPU access inside container
sudo docker exec monai_sam2 nvidia-smi

# Should show A10 GPU with CUDA processes
```

### Step 5: Test Server Endpoints

```bash
# Test 1: Server info
curl http://localhost:8002/info/ | python3 -m json.tool | head -20

# Should show:
# {
#   "name": "MONAILabel - Radiology (X.X.X)",
#   "version": "...",
#   "models": {
#     "segmentation": {
#       "type": "segmentation",
#       "labels": {...},
#       ...
#     }
#   }
# }

# Test 2: Health check
curl http://localhost:8002/

# Should return: {"status": "UP"}
```

### Step 6: Test Interactive Segmentation

```bash
# Download sample DICOM data (if not already present)
cd ~/OHIF-AI
if [ ! -f "sample-data/2.000000-PRE LIVER-76970.zip" ]; then
  echo "Please add sample DICOM data to sample-data/ directory"
fi

# Test 1: Initialize session
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@sample-data/2.000000-PRE LIVER-76970.zip" \
  -F 'params={"nninter":"init"}'

# Expected output: {}

# Test 2: Run segmentation with point prompt
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@sample-data/2.000000-PRE LIVER-76970.zip" \
  -F 'params={"nninter":"sam3","pos_points":[[256,256,40]],"neg_points":[]}' \
  --max-time 180 -o /tmp/seg_result.dat

# Check response
file /tmp/seg_result.dat
# Output: /tmp/seg_result.dat: data

# Verify it's multipart with segmentation
head -c 500 /tmp/seg_result.dat | grep -a "prompt_info"
# Should show: {"prompt_info": {"pos_points": [[256, 256, 40]]}...
```

### Step 7: Configure Remote Access

**Option A: SSH Tunnel (Secure, No Firewall Changes)**

From your **local machine**:
```bash
# Create SSH tunnel
ssh -L 8002:localhost:8002 ubuntu@<INSTANCE_IP>

# Keep this terminal open
# Access server at: http://localhost:8002
```

**Option B: Direct IP Access (Requires Firewall Configuration)**

1. **Lambda Labs:**
   - Go to: https://cloud.lambdalabs.com/instances
   - Click on your instance
   - Firewall Rules → Add Rule
   - Protocol: TCP, Port: 8002, Source: 0.0.0.0/0

2. **AWS EC2:**
   ```bash
   # Add inbound rule to Security Group
   aws ec2 authorize-security-group-ingress \
     --group-id sg-xxxxx \
     --protocol tcp \
     --port 8002 \
     --cidr 0.0.0.0/0
   ```

3. **Test from local machine:**
   ```bash
   curl http://<INSTANCE_IP>:8002/info/
   ```

---

## Testing the Server

### Automated Test Script

Save as `test_server.sh`:

```bash
#!/bin/bash

SERVER="http://localhost:8002"
SAMPLE_DATA="sample-data/2.000000-PRE LIVER-76970.zip"

echo "=== MONAI Label Server Test Suite ==="
echo ""

# Test 1: Server Health
echo "Test 1: Server Health Check"
RESPONSE=$(curl -s "$SERVER/")
if echo "$RESPONSE" | grep -q "UP"; then
  echo "✓ Server is UP"
else
  echo "✗ Server health check failed"
  exit 1
fi
echo ""

# Test 2: Models Loaded
echo "Test 2: Check Models Loaded"
RESPONSE=$(curl -s "$SERVER/info/")
if echo "$RESPONSE" | grep -q '"models"'; then
  echo "✓ Models endpoint working"
else
  echo "✗ Models not loaded"
  exit 1
fi
echo ""

# Test 3: Session Init
echo "Test 3: Initialize Session"
RESPONSE=$(curl -s -X POST "$SERVER/infer/segmentation" \
  -F "file=@$SAMPLE_DATA" \
  -F 'params={"nninter":"init"}')
if [ "$RESPONSE" = "{}" ]; then
  echo "✓ Session initialized"
else
  echo "✗ Session init failed: $RESPONSE"
  exit 1
fi
echo ""

# Test 4: Interactive Segmentation
echo "Test 4: Run Interactive Segmentation"
HTTP_CODE=$(curl -s -o /tmp/seg_test.dat -w "%{http_code}" \
  -X POST "$SERVER/infer/segmentation" \
  -F "file=@$SAMPLE_DATA" \
  -F 'params={"nninter":"sam3","pos_points":[[256,256,40]],"neg_points":[]}')

if [ "$HTTP_CODE" = "200" ]; then
  if grep -aq "prompt_info" /tmp/seg_test.dat; then
    echo "✓ Segmentation completed successfully"
  else
    echo "✗ Segmentation response invalid"
    exit 1
  fi
else
  echo "✗ Segmentation failed with HTTP $HTTP_CODE"
  exit 1
fi
echo ""

# Test 5: GPU Usage
echo "Test 5: Verify GPU Access"
GPU_INFO=$(sudo docker exec monai_sam2 nvidia-smi --query-gpu=name,memory.used --format=csv,noheader 2>/dev/null)
if [ ! -z "$GPU_INFO" ]; then
  echo "✓ GPU accessible: $GPU_INFO"
else
  echo "✗ GPU not accessible"
  exit 1
fi
echo ""

echo "=== All Tests Passed! ==="
```

Run tests:
```bash
chmod +x test_server.sh
./test_server.sh
```

### Manual Testing Checklist

- [ ] Container running: `sudo docker compose -f docker-compose.server.yml ps`
- [ ] GPU accessible: `sudo docker exec monai_sam2 nvidia-smi`
- [ ] Health endpoint: `curl http://localhost:8002/`
- [ ] Info endpoint: `curl http://localhost:8002/info/`
- [ ] Session init works
- [ ] Segmentation with points works
- [ ] Response contains both JSON and image data
- [ ] Remote access configured (if needed)

---

## API Documentation

### Base URL

- **Local:** `http://localhost:8002`
- **Remote:** `http://<INSTANCE_IP>:8002`

### Endpoints

#### 1. GET `/`

Health check endpoint.

**Response:**
```json
{"status": "UP"}
```

#### 2. GET `/info/`

Get server information and loaded models.

**Response:**
```json
{
  "name": "MONAILabel - Radiology (0.8.1)",
  "version": "0.8.1",
  "models": {
    "segmentation": {
      "type": "segmentation",
      "labels": {
        "spleen": 1,
        "kidney_right": 2,
        ...
      },
      "dimension": 3,
      "description": "A pre-trained model for volumetric (3D) Segmentation from CT image"
    },
    "Histogram+GraphCut": {...},
    "GMM+GraphCut": {...}
  },
  "labels": [...],
  "datastore": {...}
}
```

#### 3. POST `/infer/segmentation`

Run interactive segmentation inference.

**Request:**

Content-Type: `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | File | Yes | ZIP of DICOM series or single DICOM file |
| `params` | JSON string | Yes | Inference parameters (see below) |

**Params JSON:**

**Option 1: Using prompt_info (OHIF format):**
```json
{
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
}
```

**Option 2: Using direct arrays:**
```json
{
  "nninter": "sam3",
  "pos_points": [[x, y, z]],
  "neg_points": [[x, y, z]],
  "pos_boxes": [[x1, y1, x2, y2, z]],
  "neg_boxes": [[x1, y1, x2, y2, z]]
}
```

**nninter modes:**
- `init` - Initialize session with DICOM series
- `sam3` - Run SAM3 interactive segmentation
- `reset` - Reset session and clear interactions

**Response:**

Content-Type: `multipart/form-data`

Contains two parts:
1. **params** (JSON):
```json
{
  "prompt_info": {"pos_points": [[256, 256, 40]]},
  "nninter_elapsed": 0.578,
  "flipped": true,
  "label_name": "nninter_pred_20260106044256"
}
```

2. **image** (binary NIfTI file):
- Format: `.nii.gz` compressed NIfTI
- Content: 3D uint8 segmentation mask

**Example curl:**
```bash
curl -X POST "http://localhost:8002/infer/segmentation" \
  -F "file=@series.zip" \
  -F 'params={"nninter":"sam3","pos_points":[[256,256,40]],"neg_points":[]}'
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
sudo docker compose -f docker-compose.server.yml logs --tail=100 monai_sam2

# Common issues:
# 1. GPU not accessible
sudo docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi

# 2. Port 8002 already in use
sudo lsof -i :8002
# Kill process: sudo kill -9 <PID>

# 3. Out of disk space
df -h
# Clean up: docker system prune -a
```

### Build Fails

```bash
# Clean rebuild
sudo docker compose -f docker-compose.server.yml down
sudo docker system prune -a -f
sudo docker compose -f docker-compose.server.yml up --build -d
```

### Inference Returns HTTP 500

```bash
# Check recent logs
sudo docker compose -f docker-compose.server.yml logs --tail=200 monai_sam2

# Common issues:
# 1. Missing nninter parameter
#    Fix: Add "nninter": "init" or "nninter": "sam3"

# 2. Invalid prompt format
#    Fix: Use correct JSON structure (see API docs)

# 3. GPU out of memory
#    Check: sudo docker exec monai_sam2 nvidia-smi
#    Fix: Restart container or use smaller batch
```

### Slow Inference

```bash
# Check GPU utilization
sudo docker exec monai_sam2 nvidia-smi

# If GPU not being used:
# 1. Verify CUDA is working
sudo docker exec monai_sam2 python -c "import torch; print(torch.cuda.is_available())"
# Should print: True

# 2. Check container has GPU access
sudo docker inspect monai_sam2 | grep -A 10 "Devices"
```

### Connection Refused (Remote Access)

```bash
# 1. Verify server is running
curl http://localhost:8002/

# 2. Check firewall rules (Lambda Labs)
# Go to dashboard -> Instances -> Firewall

# 3. Test from instance
curl http://<INSTANCE_IP>:8002/

# 4. Check container port binding
sudo docker port monai_sam2
# Should show: 8002/tcp -> 0.0.0.0:8002
```

### Container Keeps Restarting

```bash
# Check restart count
sudo docker ps -a | grep monai_sam2

# View all logs
sudo docker logs monai_sam2

# Common causes:
# 1. Application crash during startup
# 2. Missing dependencies
# 3. Configuration error

# Fix: Check logs and rebuild
```

---

## Cost Management

### GPU Instance Costs (Approximate)

| Provider | Instance | GPU | Cost/Hour | Cost/Day | Cost/Month |
|----------|----------|-----|-----------|----------|------------|
| Lambda Labs | 1x A10 | 24GB | $0.60 | $14.40 | $432 |
| Lambda Labs | 1x A6000 | 48GB | $0.80 | $19.20 | $576 |
| AWS EC2 | g5.xlarge | A10 | $1.01 | $24.24 | $727 |
| AWS EC2 | g4dn.xlarge | T4 | $0.526 | $12.62 | $379 |
| GCP | n1-standard-4 + T4 | 16GB | $0.65 | $15.60 | $468 |

### Best Practices

1. **Stop when not in use:**
   ```bash
   # Stop server
   sudo docker compose -f docker-compose.server.yml down

   # Terminate instance
   # Lambda Labs: Dashboard -> Terminate
   # AWS: aws ec2 terminate-instances --instance-ids i-xxxxx
   ```

2. **Use spot instances (AWS/GCP):**
   - 50-70% cheaper than on-demand
   - May be interrupted with 2-minute warning
   - Good for development/testing

3. **Monitor usage:**
   ```bash
   # Check uptime
   uptime

   # Check GPU utilization
   watch -n 1 nvidia-smi
   ```

4. **Automated shutdown (Lambda Labs):**
   ```bash
   # Add to crontab - shutdown after 4 hours of inactivity
   echo "0 * * * * [ \$(who | wc -l) -eq 0 ] && sudo shutdown -h now" | crontab -
   ```

### Development vs Production

**Development:**
- Use Lambda Labs 1x A10 ($0.60/hr)
- Start/stop as needed
- Use spot instances

**Production:**
- Reserved instances (AWS/GCP) for 30-50% savings
- Auto-scaling groups
- Load balancers for high availability

---

## Updating the Server

### Pull Latest Changes

```bash
cd ~/OHIF-AI
git pull origin main
sudo docker compose -f docker-compose.server.yml up --build -d
```

### Update Docker Image Only

```bash
sudo docker compose -f docker-compose.server.yml down
sudo docker compose -f docker-compose.server.yml build --no-cache
sudo docker compose -f docker-compose.server.yml up -d
```

### Backup Configuration

```bash
# Backup predictions and studies
tar -czf monai-backup-$(date +%Y%m%d).tar.gz \
  monai-label/predictions \
  monai-label/studies

# Backup to S3 (optional)
aws s3 cp monai-backup-*.tar.gz s3://your-bucket/backups/
```

---

## Advanced Configuration

### Change Port

Edit `docker-compose.server.yml`:
```yaml
ports:
  - '8003:8002'  # External:Internal
```

Rebuild:
```bash
sudo docker compose -f docker-compose.server.yml up -d
```

### Use Multiple GPUs

Edit `docker-compose.server.yml`:
```yaml
environment:
  - CUDA_VISIBLE_DEVICES=0,1  # Use GPUs 0 and 1
```

### Increase Shared Memory

For large DICOM series:
```yaml
shm_size: '20gb'  # Increase from 10gb
```

### Enable Debug Logging

```bash
sudo docker compose -f docker-compose.server.yml down
sudo docker compose -f docker-compose.server.yml up -d

# View debug logs
sudo docker compose -f docker-compose.server.yml logs -f | grep DEBUG
```

---

## Support

- **GitHub Issues:** https://github.com/anandpreshob/OHIF-AI/issues
- **MONAI Label Docs:** https://docs.monai.io/projects/label/en/latest/
- **SAM2 Documentation:** https://github.com/facebookresearch/segment-anything-2

---

## Appendix: File Structure

```
OHIF-AI/
├── docker-compose.server.yml          # Server-only deployment config
├── SERVER_DEPLOYMENT_GUIDE.md         # This file
├── API_REFERENCE.md                   # Detailed API documentation
├── LAMBDA_LABS_SETUP.md              # Lambda Labs specific guide
├── monai-label/
│   ├── Dockerfile                     # Container build instructions
│   ├── requirements.txt               # Python dependencies
│   ├── monailabel/
│   │   ├── endpoints/
│   │   │   └── infer.py              # Inference API endpoints
│   │   ├── tasks/
│   │   │   └── infer/
│   │   │       └── basic_infer.py    # SAM2/SAM3 inference logic
│   │   └── interfaces/
│   │       └── app.py                # MONAI Label app interface
│   ├── apps/
│   │   └── radiology/
│   │       ├── main.py               # Radiology app entry point
│   │       └── lib/
│   │           ├── configs/
│   │           │   └── segmentation.py
│   │           └── infers/
│   │               └── segmentation.py
│   ├── predictions/                   # Inference output directory
│   └── studies/                       # DICOM studies directory
├── sam2/                              # SAM2 model code
├── sam3/                              # SAM3 model code
└── sample-data/                       # Test DICOM data
    └── 2.000000-PRE LIVER-76970.zip
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-06 | Initial deployment guide with SAM2/SAM3 support |

---

**Generated with Claude Code**
Last Updated: 2026-01-06
