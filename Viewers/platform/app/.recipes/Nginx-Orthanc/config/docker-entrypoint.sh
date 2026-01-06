#!/bin/sh
# Docker entrypoint script for OHIF Viewer with configurable MONAI server
#
# This script substitutes environment variables in the nginx config template
# and then starts nginx.
#
# Environment variables:
#   MONAI_SERVER_HOST - IP address or hostname of the MONAI Label server (default: 129.213.144.179)
#   MONAI_SERVER_PORT - Port of the MONAI Label server (default: 8002)

set -e

# Set defaults if not provided
export MONAI_SERVER_HOST=${MONAI_SERVER_HOST:-129.213.144.179}
export MONAI_SERVER_PORT=${MONAI_SERVER_PORT:-8002}

echo "Configuring OHIF Viewer..."
echo "  MONAI Server: ${MONAI_SERVER_HOST}:${MONAI_SERVER_PORT}"

# Check if template exists
if [ -f /etc/nginx/nginx.conf.template ]; then
    echo "Processing nginx.conf.template..."
    # Use envsubst to replace environment variables
    # Only substitute our specific variables to avoid breaking nginx $variables
    envsubst '${MONAI_SERVER_HOST} ${MONAI_SERVER_PORT}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
    echo "nginx.conf generated successfully"
else
    echo "No template found, using existing nginx.conf"
fi

echo "Starting nginx..."
exec nginx -g 'daemon off;'
