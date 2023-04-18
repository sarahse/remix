import * as path from "path";
import { builtinModules as nodeBuiltins } from "module";
import * as esbuild from "esbuild";
import { polyfillNode as NodeModulesPolyfillPlugin } from "esbuild-plugin-polyfill-node";

import type { RemixConfig } from "../../config";
import { type Manifest } from "../../manifest";
import { getAppDependencies } from "../../dependencies";
import { loaders } from "../utils/loaders";
import { browserRouteModulesPlugin } from "./plugins/routes";
import { browserRouteModulesPlugin as browserRouteModulesPlugin_v2 } from "./plugins/routes_unstable";
import { cssFilePlugin } from "../plugins/cssImports";
import { absoluteCssUrlsPlugin } from "../plugins/absoluteCssUrlsPlugin";
import { deprecatedRemixPackagePlugin } from "../plugins/deprecatedRemixPackage";
import { emptyModulesPlugin } from "../plugins/emptyModules";
import { mdxPlugin } from "../plugins/mdx";
import { externalPlugin } from "../plugins/external";
import { cssBundleUpdatePlugin } from "./plugins/cssBundleUpdate";
import { cssModulesPlugin } from "../plugins/cssModuleImports";
import { cssSideEffectImportsPlugin } from "../plugins/cssSideEffectImports";
import { vanillaExtractPlugin } from "../plugins/vanillaExtract";
import invariant from "../../invariant";
import { hmrPlugin } from "./plugins/hmr";
import { createMatchPath } from "../utils/tsconfig";
import { getPreferredPackageManager } from "../../cli/getPreferredPackageManager";
import { type ReadChannel } from "../../channel";
import type { Context } from "../context";

type Compiler = {
  // produce ./public/build/
  compile: () => Promise<{
    metafile: esbuild.Metafile;
    hmr?: Manifest["hmr"];
  }>;
  cancel: () => Promise<void>;
  dispose: () => Promise<void>;
};

function getNpmPackageName(id: string): string {
  let split = id.split("/");
  let packageName = split[0];
  if (packageName.startsWith("@")) packageName += `/${split[1]}`;
  return packageName;
}

function isBareModuleId(id: string): boolean {
  return !id.startsWith("node:") && !id.startsWith(".") && !path.isAbsolute(id);
}

function isNodeBuiltIn(packageName: string) {
  return nodeBuiltins.includes(packageName);
}

const getExternals = (remixConfig: RemixConfig): string[] => {
  // For the browser build, exclude node built-ins that don't have a
  // browser-safe alternative installed in node_modules. Nothing should
  // *actually* be external in the browser build (we want to bundle all deps) so
  // this is really just making sure we don't accidentally have any dependencies
  // on node built-ins in browser bundles.
  let dependencies = Object.keys(getAppDependencies(remixConfig));
  let fakeBuiltins = nodeBuiltins.filter((mod) => dependencies.includes(mod));

  if (fakeBuiltins.length > 0) {
    throw new Error(
      `It appears you're using a module that is built in to node, but you installed it as a dependency which could cause problems. Please remove ${fakeBuiltins.join(
        ", "
      )} before continuing.`
    );
  }
  return nodeBuiltins.filter((mod) => !dependencies.includes(mod));
};

const createEsbuildConfig = (
  ctx: Context,
  onLoader: (filename: string, code: string) => void,
  channels: { cssBundleHref: ReadChannel<string | undefined> }
): esbuild.BuildOptions => {
  let entryPoints: Record<string, string> = {
    "entry.client": ctx.config.entryClientFilePath,
  };

  for (let id of Object.keys(ctx.config.routes)) {
    // All route entry points are virtual modules that will be loaded by the
    // browserEntryPointsPlugin. This allows us to tree-shake server-only code
    // that we don't want to run in the browser (i.e. action & loader).
    entryPoints[id] = ctx.config.routes[id].file + "?browser";
  }

  let matchPath = ctx.config.tsconfigPath
    ? createMatchPath(ctx.config.tsconfigPath)
    : undefined;
  function resolvePath(id: string) {
    if (!matchPath) {
      return id;
    }
    return (
      matchPath(id, undefined, undefined, [".ts", ".tsx", ".js", ".jsx"]) || id
    );
  }

  let plugins: esbuild.Plugin[] = [
    deprecatedRemixPackagePlugin(ctx),
    cssModulesPlugin(ctx, { outputCss: false }),
    vanillaExtractPlugin(ctx, { outputCss: false }),
    cssSideEffectImportsPlugin(ctx),
    cssFilePlugin(ctx),
    absoluteCssUrlsPlugin(),
    externalPlugin(/^https?:\/\//, { sideEffects: false }),
    mdxPlugin(ctx),
    ctx.config.future.unstable_dev
      ? browserRouteModulesPlugin_v2(ctx, /\?browser$/, onLoader)
      : browserRouteModulesPlugin(ctx, /\?browser$/),
    emptyModulesPlugin(ctx, /\.server(\.[jt]sx?)?$/),
    NodeModulesPolyfillPlugin(),
    externalPlugin(/^node:.*/, { sideEffects: false }),
    {
      // TODO: should be removed when error handling for compiler is improved
      name: "warn-on-unresolved-imports",
      setup: (build) => {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (!isBareModuleId(resolvePath(args.path))) {
            return undefined;
          }

          if (args.path === "remix:hmr") {
            return undefined;
          }

          let packageName = getNpmPackageName(args.path);
          let pkgManager = getPreferredPackageManager();
          if (
            ctx.options.onWarning &&
            !isNodeBuiltIn(packageName) &&
            !/\bnode_modules\b/.test(args.importer) &&
            // Silence spurious warnings when using Yarn PnP. Yarn PnP doesn’t use
            // a `node_modules` folder to keep its dependencies, so the above check
            // will always fail.
            (pkgManager === "npm" ||
              (pkgManager === "yarn" && process.versions.pnp == null))
          ) {
            try {
              require.resolve(args.path);
            } catch (error: unknown) {
              ctx.options.onWarning(
                `The path "${args.path}" is imported in ` +
                  `${path.relative(process.cwd(), args.importer)} but ` +
                  `"${args.path}" was not found in your node_modules. ` +
                  `Did you forget to install it?`,
                args.path
              );
            }
          }
          return undefined;
        });
      },
    } as esbuild.Plugin,
  ];

  if (ctx.options.mode === "development" && ctx.config.future.unstable_dev) {
    // TODO prebundle deps instead of chunking just these ones
    let isolateChunks = [
      require.resolve("react"),
      require.resolve("react/jsx-dev-runtime"),
      require.resolve("react/jsx-runtime"),
      require.resolve("react-dom"),
      require.resolve("react-dom/client"),
      require.resolve("react-refresh/runtime"),
      require.resolve("@remix-run/react"),
      "remix:hmr",
    ];
    entryPoints = {
      ...entryPoints,
      ...Object.fromEntries(isolateChunks.map((imprt) => [imprt, imprt])),
    };

    plugins.push(hmrPlugin(ctx));
    plugins.push(cssBundleUpdatePlugin(channels));
  }

  return {
    entryPoints,
    outdir: ctx.config.assetsBuildDirectory,
    platform: "browser",
    format: "esm",
    external: getExternals(ctx.config),
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    splitting: true,
    sourcemap: ctx.options.sourcemap,
    // As pointed out by https://github.com/evanw/esbuild/issues/2440, when tsconfig is set to
    // `undefined`, esbuild will keep looking for a tsconfig.json recursively up. This unwanted
    // behavior can only be avoided by creating an empty tsconfig file in the root directory.
    tsconfig: ctx.config.tsconfigPath,
    mainFields: ["browser", "module", "main"],
    treeShaking: true,
    minify: ctx.options.mode === "production",
    entryNames: "[dir]/[name]-[hash]",
    chunkNames: "_shared/[name]-[hash]",
    assetNames: "_assets/[name]-[hash]",
    publicPath: ctx.config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(ctx.options.mode),
      "process.env.REMIX_DEV_SERVER_WS_PORT": JSON.stringify(
        ctx.config.devServerPort
      ),
    },
    jsx: "automatic",
    jsxDev: ctx.options.mode !== "production",
    plugins,
    supported: {
      "import-meta": true,
    },
  };
};

export const create = async (
  ctx: Context,
  channels: { cssBundleHref: ReadChannel<string | undefined> }
): Promise<Compiler> => {
  let hmrRoutes: Record<string, { loaderHash: string }> = {};
  let onLoader = (filename: string, code: string) => {
    let key = path.relative(ctx.config.rootDirectory, filename);
    hmrRoutes[key] = { loaderHash: code };
  };

  let compiler = await esbuild.context({
    ...createEsbuildConfig(ctx, onLoader, channels),
    metafile: true,
  });

  let compile = async () => {
    hmrRoutes = {};
    let { metafile } = await compiler.rebuild();

    let hmr: Manifest["hmr"] | undefined = undefined;
    if (ctx.options.mode === "development" && ctx.config.future.unstable_dev) {
      let hmrRuntimeOutput = Object.entries(metafile.outputs).find(
        ([_, output]) => output.inputs["hmr-runtime:remix:hmr"]
      )?.[0];
      invariant(hmrRuntimeOutput, "Expected to find HMR runtime in outputs");
      let hmrRuntime =
        ctx.config.publicPath +
        path.relative(
          ctx.config.assetsBuildDirectory,
          path.resolve(hmrRuntimeOutput)
        );
      hmr = {
        runtime: hmrRuntime,
        routes: hmrRoutes,
        timestamp: Date.now(),
      };
    }

    return { metafile, hmr };
  };

  return {
    compile,
    cancel: compiler.cancel,
    dispose: compiler.dispose,
  };
};
