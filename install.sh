#!/usr/bin/env bash
# Mimic AI — one-command installer
# Usage: bash install.sh

set -e

REPO="https://github.com/miapre/mimic-ai.git"
DEFAULT_DIR="$HOME/mimic-ai"

echo ""
echo "Mimic AI installer"
echo "======================================"
echo ""

# Check dependencies
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required (v20.6+). Install it from https://nodejs.org and re-run."
  exit 1
fi

if ! command -v git &>/dev/null; then
  echo "Error: git is required. Install it from https://git-scm.com and re-run."
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
if ! npm install; then
  echo ""
  echo "Error: npm install failed. Fix the error above and re-run."
  exit 1
fi

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

# settings.json — offer to write automatically
SETTINGS_FILE="$HOME/.claude/settings.json"
echo ""
echo "======================================"
echo "Register Mimic AI in Claude Code"
echo ""
read -rp "Auto-update $SETTINGS_FILE? [Y/n]: " AUTO_WRITE
AUTO_WRITE="${AUTO_WRITE:-Y}"

if [[ "$AUTO_WRITE" =~ ^[Yy]$ ]]; then
  node -e "
    const fs = require('fs');
    const path = '$SETTINGS_FILE';
    let config = {};
    if (fs.existsSync(path)) {
      try { config = JSON.parse(fs.readFileSync(path, 'utf8')); }
      catch(e) { console.error('Warning: could not parse ' + path + ' — adding mcpServers key.'); }
    }
    if (!config.mcpServers) config.mcpServers = {};
    if (config.mcpServers['mimic-ai']) {
      console.log('mimic-ai entry already present — updating path.');
    }
    config.mcpServers['mimic-ai'] = { command: 'node', args: ['$INSTALL_DIR/mcp.js'] };
    fs.mkdirSync(require('path').dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    console.log('Written to $SETTINGS_FILE');
  "
  if [ $? -ne 0 ]; then
    echo ""
    echo "Auto-write failed. Add this manually to $SETTINGS_FILE under \"mcpServers\":"
    echo ""
    echo "    \"mimic-ai\": {"
    echo "      \"command\": \"node\","
    echo "      \"args\": [\"$INSTALL_DIR/mcp.js\"]"
    echo "    }"
  fi
else
  echo ""
  echo "Add this manually to $SETTINGS_FILE under \"mcpServers\":"
  echo ""
  echo "    \"mimic-ai\": {"
  echo "      \"command\": \"node\","
  echo "      \"args\": [\"$INSTALL_DIR/mcp.js\"]"
  echo "    }"
fi
echo ""
echo "Restart Claude Code to load the MCP server."
echo ""
echo "======================================"
echo ""
echo "Installation complete."
echo ""
echo "Each session:"
echo "  1. Start the bridge:  cd $INSTALL_DIR && npm run bridge"
echo "  2. In Figma desktop:  Plugins > Development > Mimic AI > Run"
echo "  3. Talk to Claude."
echo ""
