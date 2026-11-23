#!/usr/bin/env node
// The viewer now ships inside the plugin (consensus-claude-plugin/viz/brain.mjs), so every install has it.
// This forwarder keeps `node consensus-viz/brain.mjs` working from a clone of the repo.
import '../consensus-claude-plugin/viz/brain.mjs';
