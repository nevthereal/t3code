import fs from "node:fs";

import { Effect, Logger, References, Layer } from "effect";

import { ServerConfig } from "./config";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const { logsDir, serverLogPath } = config;

  yield* Effect.sync(() => {
    fs.mkdirSync(logsDir, { recursive: true });
  });

  const fileLogger = Logger.formatSimple.pipe(Logger.toFile(serverLogPath));
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer([Logger.consolePretty(), fileLogger], {
    mergeWithExisting: false,
  });

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
