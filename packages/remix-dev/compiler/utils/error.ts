import esbuild from "esbuild";

let toError = (thrown: unknown): Error => {
  if (thrown instanceof Error) return thrown;
  try {
    return new Error(JSON.stringify(thrown));
  } catch {
    // fallback in case there's an error stringifying.
    // for example, due to circular references.
    return new Error(String(thrown));
  }
};

let isEsbuildError = (error: Error): error is esbuild.BuildFailure => {
  return "warnings" in error && "errors" in error;
};

let logEsbuildError = (error: esbuild.BuildFailure) => {
  let warnings = esbuild.formatMessagesSync(error.warnings, {
    kind: "warning",
    color: true,
  });
  warnings.forEach(console.warn);
  let errors = esbuild.formatMessagesSync(error.warnings, {
    kind: "warning",
    color: true,
  });
  errors.forEach(console.error);
};

export let logThrown = (thrown: unknown) => {
  let error = toError(thrown);
  if (isEsbuildError(error)) {
    logEsbuildError(error);
  } else {
    console.error(error.message);
  }
};
