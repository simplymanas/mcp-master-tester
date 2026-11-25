# The container scan.mjs runs in: Node for npx packages, uv for PyPI ones. The servers are other
# people's code, so they run here, as an unprivileged user, and not on the Actions runner itself,
# where they could reach the runner's token or the repository's caches.
# The full Debian image, not -slim: some PyPI servers need a compiler or git to install.
FROM ghcr.io/astral-sh/uv:0.13.8 AS uv
FROM node:22-bookworm
COPY --from=uv /uv /uvx /usr/local/bin/
RUN mkdir /work && chown node:node /work
USER node
ENV HOME=/home/node \
    SCORECARD_WORK=/work \
    npm_config_cache=/tmp/npm-cache \
    npm_config_ignore_scripts=true \
    npm_config_update_notifier=false \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_PYTHON_INSTALL_DIR=/tmp/uv-python
WORKDIR /work
