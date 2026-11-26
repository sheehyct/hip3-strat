# Container image for the HIP-3 scanner / alert worker.
# Build context = this repo root: the worker and the dashboard HTML live
# together, and the server serves ./hip3_strat_screener.html next to
# server.js. .dockerignore trims runtime state and docs from the image.
FROM node:22-slim
WORKDIR /app

COPY . .

# Anti-drift gate at image build: the deploy fails if the vendored detection
# core no longer matches the dashboard STRAT-CORE block.
RUN node scripts/extract_core.js --check

# Containers need a non-loopback bind; a bare `node server.js` outside Docker
# still defaults to 127.0.0.1. Most hosts inject PORT.
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.js"]
