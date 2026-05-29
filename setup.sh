#!/usr/bin/env bash
set -euo pipefail

echo "[*] Nexus Forge MCP — Setup"
echo ""

if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install Node.js v18+ first."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js v18+ required (found v$(node -v))"
  exit 1
fi
echo "✓ Node.js $(node -v)"

cd "$(dirname "$0")"

echo "[*] Installing dependencies..."
npm install

echo "[*] Compiling TypeScript..."
npx tsc

echo ""
echo "[✓] Nexus Forge MCP ready at $(pwd)/build/index.js"
echo ""
echo "Register with your MCP client:"
echo ""
echo '  "mcpServers": {'
echo '    "nexus-forge-mcp": {'
echo '      "command": "node",'
echo '      "args": ["'"$(pwd)"'/build/index.js"],'
echo '      "env": { "GITHUB_TOKEN": "your_github_pat_here" }'
echo '    }'
echo '  }'
