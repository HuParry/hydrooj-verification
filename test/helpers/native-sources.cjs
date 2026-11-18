'use strict';

const path = require('node:path');

// Development uses the surrounding Hydro workspace. Independent checkouts and
// CI provide the pinned upstream source tree explicitly.
const sourceRoot = process.env.HYDRO_SOURCE_DIR
  ? path.resolve(process.env.HYDRO_SOURCE_DIR)
  : path.resolve(__dirname, '../../../..');

module.exports = relativePath => path.join(sourceRoot, 'packages', relativePath);
