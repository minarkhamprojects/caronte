require("dotenv").config();
module.exports = {
  apps: [{
    name: "caronte",
    script: "server.mjs",
    env: {
      CARONTE_TOKEN: process.env.CARONTE_TOKEN,
      CARONTE_PORT: process.env.CARONTE_PORT || "8788",
      CARONTE_LOCAL_NAME: process.env.CARONTE_LOCAL_NAME || "server",
      CARONTE_REMOTE_HOSTS: process.env.CARONTE_REMOTE_HOSTS || "[]",
    },
  }],
};
