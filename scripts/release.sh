#!/bin/bash

set -e

echo "🚀 Gemini MCP Server Release Script"
echo "===================================="

# Check if we're on main branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
    echo "❌ Error: Releases must be created from the main branch"
    echo "Current branch: $BRANCH"
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes"
    git status --short
    exit 1
fi

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull origin main

# Run tests
echo "🧪 Running tests..."
npm test

# Build the project
echo "🔨 Building project..."
npm run build

# Prompt for version bump type
echo ""
echo "Select version bump type:"
echo "1) patch (0.1.0 -> 0.1.1)"
echo "2) minor (0.1.0 -> 0.2.0)"
echo "3) major (0.1.0 -> 1.0.0)"
echo "4) prerelease (0.1.0 -> 0.1.1-alpha.0)"
read -p "Enter choice [1-4]: " choice

case $choice in
    1) VERSION_TYPE="patch";;
    2) VERSION_TYPE="minor";;
    3) VERSION_TYPE="major";;
    4) VERSION_TYPE="prerelease";;
    *) echo "Invalid choice"; exit 1;;
esac

# Bump version
echo "📝 Bumping version..."
npm version $VERSION_TYPE

# Get the new version
VERSION=$(node -p "require('./package.json').version")

# Push changes and tag
echo "📤 Pushing to GitHub..."
git push origin main
git push origin "v$VERSION"

echo ""
echo "✅ Release v$VERSION created successfully!"
echo ""
echo "The GitHub Actions workflow will now:"
echo "1. Run CI tests"
echo "2. Publish to NPM"
echo "3. Create a GitHub release"
echo ""
echo "Monitor progress at: https://github.com/yourusername/gemini-mcp-server/actions"