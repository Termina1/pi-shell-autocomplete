FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    zsh \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install oh-my-zsh for git completions
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended || true

# Enable git plugin for completions
RUN sed -i 's/plugins=(git)/plugins=(git docker)/' /root/.zshrc 2>/dev/null || \
    echo 'plugins=(git docker)' >> /root/.zshrc

# Ensure compinit runs
RUN echo 'autoload -Uz compinit && compinit -D' >> /root/.zshrc

# Node.js for test runner
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json vitest.config.ts ./
COPY *.ts ./
COPY __tests__/ ./__tests__/

RUN npm install

# Models are expected at /models/ (mount from host)
# docker run -v ~/.pi/agent/models:/models ...

CMD ["npx", "vitest", "run", "__tests__/integration/"]
