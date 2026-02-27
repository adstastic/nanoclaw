#!/bin/bash
# Build custom signal-cli-rest-api image with signal-cli from master (binary ACI fix)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-signal-api"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

echo "Building custom signal-api image (signal-cli from master)..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "To deploy:"
echo "  container stop signal-api"
echo "  container rm signal-api"
echo "  container run -d --name signal-api \\"
echo "    -e MODE=json-rpc \\"
echo "    -e SIGNAL_CLI_CHOWN_ON_STARTUP=false \\"
echo "    -p 8080:8080 \\"
echo "    -v store/signal-cli:/home/.local/share/signal-cli \\"
echo "    ${IMAGE_NAME}:${TAG}"
