#!/usr/bin/env bash
# figma-write-mcp — one-command installer
# Usage: bash install.sh

set -e

REPO="https://github.com/miapre/figma-write-mcp.git"
DEFAULT_DIR="$HOME/figma-write-mcp"

echo ""
echo "figma-write-mcp installer"
echo "========================="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required (v20.6+). Install it from https://nodejs.org and re-run."
  exit 1
fi

NODE_VER=$(node -e "
  const [major, minor] = process.versions.node.split('.').map(Number);
  process.exit((major > 20 || (major === 20 && minor >= 6)) ? 0 : 1);
" 2>/dev/null && echo "ok" || echo "old")
if [ "$NODE_VER" = "old" ]; then
  echo "Error: Node.js v20.6 or later is required (needed for --env-file support)."
  echo "You have $(node -v). Download the latest LTS from https://nodejs.org"
  exit 1
fi

# Install location
read -rp "Install directory [$DEFAULT_DIR]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"

if [ -d "$INSTALL_DIR" ]; then
  echo "Directory $INSTALL_DIR already exists — skipping clone."
else
  echo ""
  echo "Cloning into $INSTALL_DIR..."
  git clone "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

echo ""
echo "Installing dependencies..."
npm install

# .env setup
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  read -rp "Figma Personal Access Token (leave blank to set later): " TOKEN
  if [ -n "$TOKEN" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/your_figma_personal_access_token_here/$TOKEN/" .env
    else
      sed -i "s/your_figma_personal_access_token_here/$TOKEN/" .env
    fi
    echo "Token saved to .env"
  else
    echo "Skipped — edit $INSTALL_DIR/.env later to add your token."
  fi
fi

# settings.json snippet
echo ""
echo "========================="
echo "Almost done. Add this block to ~/.claude/settings.json under \"mcpServers\":"
echo ""
echo "    \"figma-write-mcp\": {"
echo "      \"command\": \"node\","
echo "      \"args\": [\"$INSTALL_DIR/mcp.js\"]"
echo "    }"
echo ""
echo "Then restart Claude Code."
echo ""
echo "========================="
echo ""
echo "Installation complete."
echo ""
echo "Each session:"
echo "  1. Start the bridge:  cd $INSTALL_DIR && npm run bridge"
echo "  2. In Figma desktop:  Plugins > Development > Figma Write Bridge > Run"
echo "  3. Talk to Claude."
echo ""
