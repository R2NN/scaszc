FROM node:22-bookworm-slim AS app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY algorithm/requirements-full.txt algorithm/requirements-full.txt
RUN python3 -m venv /opt/beego-venv \
    && /opt/beego-venv/bin/pip install --no-cache-dir -r algorithm/requirements-full.txt

COPY site/package.json site/pnpm-lock.yaml site/pnpm-workspace.yaml site/.npmrc site/
WORKDIR /app/site
RUN pnpm install --frozen-lockfile

WORKDIR /app
COPY algorithm algorithm
COPY data/dataset data/dataset
COPY data/transit data/transit
COPY runtime runtime
COPY site site
RUN cd site && pnpm run build \
    && python3 /app/algorithm/tools/install_weekly_rail_snapshots.py \
      --destination /app/offline-assets/transit-sources/rail \
    && mkdir -p /app/runtime/ui-runs /app/runtime/ui-shared-cache /app/runtime/exact-replans /app/site/.beego-data \
    && chown -R node:node /app/runtime /app/site/.beego-data

ENV BEEGO_HOST=0.0.0.0 \
    BEEGO_PYTHON=/opt/beego-venv/bin/python \
    BEEGO_DB_PATH=/app/site/.beego-data/shifts.sqlite3 \
    VALHALLA_ROUTE_ENDPOINT=http://valhalla:8002/route \
    PORT=8787

WORKDIR /app/site
EXPOSE 8787
USER node
CMD ["node", "server/main.mjs"]
