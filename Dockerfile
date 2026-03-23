FROM node:22-slim

RUN apt-get update && apt-get install -y curl git gosu && rm -rf /var/lib/apt/lists/*

# Install claude-code globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy and install host dependencies
COPY package*.json ./
RUN npm install

# Copy and install agent-runner dependencies
COPY container/agent-runner/package*.json ./container/agent-runner/
RUN cd container/agent-runner && npm install

# Copy all source
COPY . .

# Build host and agent-runner
RUN npm run build && cd container/agent-runner && npm run build

ENV NATIVE_MODE=true
ENV NODE_ENV=production

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

CMD ["./entrypoint.sh"]
