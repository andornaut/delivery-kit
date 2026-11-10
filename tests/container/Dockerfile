# syntax=docker/dockerfile:1.25
ARG NODE_VERSION
FROM koalaman/shellcheck:v0.11.0 AS shellcheck
FROM node:${NODE_VERSION}

RUN install -d -o 19001 -g 19001 /opt/check /opt/check/root /opt/check/contract /opt/check/npm-cache \
    && ln -s /opt/check/root/node_modules /node_modules
COPY --chown=19001:19001 package.json package-lock.json /opt/check/root/
COPY --chown=19001:19001 tests/contract/package.json tests/contract/package-lock.json /opt/check/contract/

USER 19001:19001
ENV HOME=/tmp
ENV PATH=/opt/check/root/node_modules/.bin:${PATH}
RUN cd /opt/check/root && npm_config_cache=/opt/check/npm-cache npm ci --ignore-scripts --no-audit --no-fund \
    && cd /opt/check/contract && npm_config_cache=/opt/check/npm-cache npm ci --ignore-scripts --no-audit --no-fund

COPY --chown=19001:19001 --chmod=0755 tests/container/check /opt/check/run
COPY --from=shellcheck /bin/shellcheck /usr/local/bin/shellcheck
WORKDIR /work
