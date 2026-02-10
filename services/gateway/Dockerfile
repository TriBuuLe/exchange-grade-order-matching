FROM node:20-alpine

WORKDIR /app

COPY services/gateway/package.json \
     services/gateway/package-lock.json* \
     services/gateway/pnpm-lock.yaml* \
     services/gateway/yarn.lock* ./

RUN if [ -f pnpm-lock.yaml ]; then \
      corepack enable && pnpm i --frozen-lockfile; \
    elif [ -f yarn.lock ]; then \
      yarn --frozen-lockfile; \
    else \
      npm ci; \
    fi

# Copy gateway source
COPY services/gateway .

# Copy shared proto definitions
COPY proto ./proto

EXPOSE 8080
ENV ENABLE_ORDERS=true

CMD ["npm","run","dev"]
