import { EXIT_FETCH_ERROR, main } from "./check-live-drift.mjs";

main({ argv: ["--json"] }).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = EXIT_FETCH_ERROR;
  },
);
