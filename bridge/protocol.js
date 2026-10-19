'use strict';

module.exports = {
  ...require('./proto/strip'),
  ...require('./proto/versions'),
  ...require('./proto/transport'),
  ...require('./proto/prompt'),
  ...require('./proto/permissions'),
  ...require('./proto/luaout'),
  ...require('./proto/map'),
  ...require('./proto/macros'),
  ...require('./proto/widgets'),
};
