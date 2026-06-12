#!/bin/bash
# Quick Release Script — Hermes Paperclip Adapter v0.4.0
# Run this script to publish the adapter to SMTGROUP fork and create upstream PR
# 
# Usage: bash /home/argus/hermes-paperclip-adapter/QUICK_RELEASE.sh

set -e

echo "════════════════════════════════════════════════════════════════"
echo "Hermes Paperclip Adapter — v0.4.0 Quick Release"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Step 1: Verify environment
echo "[1/5] Verifying environment..."
cd /home/argus/hermes-paperclip-adapter

if ! npm test --silent 2>/dev/null; then
    echo "❌ Tests failed. Aborting release."
    exit 1
fi
echo "✅ Tests passing"

if ! npm run typecheck 2>/dev/null; then
    echo "❌ TypeScript errors. Aborting release."
    exit 1
fi
echo "✅ TypeScript clean"

if ! npm run build --silent 2>/dev/null; then
    echo "❌ Build failed. Aborting release."
    exit 1
fi
echo "✅ Build clean"

# Step 2: Verify git state
echo ""
echo "[2/5] Verifying git state..."
if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️  WARNING: Uncommitted changes detected. Please commit first."
    git status --short
    exit 1
fi
echo "✅ Working tree clean"

COMMITS_AHEAD=$(git rev-list --count origin/main..main || echo "unknown")
echo "✅ $COMMITS_AHEAD commits ready to push"

# Step 3: Create/verify fork remote
echo ""
echo "[3/5] Setting up fork remote..."

FORK_URL="https://github.com/smtcenter/hermes-paperclip-adapter-smtgroup"
FORK_NAME="smtgroup-fork"

if git remote get-url $FORK_NAME 2>/dev/null; then
    echo "✅ Fork remote already configured: $FORK_URL"
else
    echo "Adding fork remote..."
    git remote add $FORK_NAME $FORK_URL
    echo "✅ Fork remote added"
fi

# Step 4: Push to fork
echo ""
echo "[4/5] Pushing to SMTGROUP fork..."
git push $FORK_NAME main --force
git push $FORK_NAME --tags
echo "✅ Pushed to fork"

# Step 5: Create and push release tag
echo ""
echo "[5/5] Creating release tag (v0.4.0-smtgroup)..."

TAG_NAME="v0.4.0-smtgroup"
TAG_MESSAGE="SMTGROUP Release: stress tests, CI/CD, comprehensive docs

Improvements:
- 10 comprehensive stress tests (session persistence, memory stability, concurrency, error recovery)
- GitHub Actions CI/CD workflow for automated testing
- Edge case handling improvements (missing session IDs, large responses, empty output)
- Full TypeScript type safety (strict mode, 0 errors)
- Complete documentation suite (6 guides + edge cases roadmap)
- Production hardening and validation

Release Date: June 11, 2026
Status: Production-ready for agent fleet deployment

Total commits in this release: $COMMITS_AHEAD"

git tag -a $TAG_NAME -m "$TAG_MESSAGE"
git push $FORK_NAME $TAG_NAME
echo "✅ Release tag created and pushed"

# Summary
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✅ RELEASE COMPLETE — v0.4.0-smtgroup"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Fork URL: $FORK_URL"
echo "Tag: $TAG_NAME"
echo ""
echo "Next steps:"
echo "1. Create upstream PR: $FORK_URL/compare/main"
echo "2. Deploy to agent fleet:"
echo "   npm install github:smtcenter/hermes-paperclip-adapter-smtgroup#$TAG_NAME"
echo "3. Monitor agent heartbeats for capability verification"
echo ""
echo "Estimated agent fleet update time: ~30 minutes (246 agents)"
echo ""
