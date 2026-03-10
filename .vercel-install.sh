#!/bin/bash
# Rewrite all github SSH refs to HTTPS+token for private repos
if [ -n "$GITHUB_TOKEN" ]; then
  sed -i "s|github:mzon7/|git+https://${GITHUB_TOKEN}@github.com/mzon7/|g" package.json
  sed -i "s|git+ssh://git@github.com/mzon7/|git+https://${GITHUB_TOKEN}@github.com/mzon7/|g" package-lock.json
  sed -i "s|ssh://git@github.com/mzon7/|https://${GITHUB_TOKEN}@github.com/mzon7/|g" package-lock.json
fi
npm install
