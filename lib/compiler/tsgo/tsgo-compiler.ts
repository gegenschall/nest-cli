import * as chokidar from 'chokidar';
import { spawn } from 'child_process';
import { dirname, isAbsolute, join } from 'path';
import * as ts from 'typescript';
import { Configuration } from '../../configuration';
import { defaultOutDir } from '../../configuration/defaults';
import { CLI_ERRORS, ERROR_PREFIX, INFO_PREFIX } from '../../ui';
import { treeKillSync } from '../../utils/tree-kill';
import { AssetsManager } from '../assets-manager';
import { BaseCompiler } from '../base-compiler';
import { getValueOrDefault } from '../helpers/get-value-or-default';
import { TsConfigProvider } from '../helpers/tsconfig-provider';
import { PluginMetadataGenerator } from '../plugins/plugin-metadata-generator';
import { MultiNestCompilerPlugins, PluginsLoader } from '../plugins/plugins-loader';
import { TypeScriptBinaryLoader } from '../typescript-loader';

export type TsgoCompilerExtras = {
  watch: boolean;
  assetsManager: AssetsManager;
  tsOptions: ts.CompilerOptions;
  fallbackToTsc: () => Promise<void>;
};

export class TsgoCompiler extends BaseCompiler<TsgoCompilerExtras> {
  private readonly pluginMetadataGenerator = new PluginMetadataGenerator();

  constructor(
    pluginsLoader: PluginsLoader,
    private readonly tsConfigProvider: TsConfigProvider,
    private readonly typescriptLoader: TypeScriptBinaryLoader,
  ) {
    super(pluginsLoader);
  }

  public async run(
    configuration: Required<Configuration>,
    tsConfigPath: string,
    appName: string | undefined,
    extras: TsgoCompilerExtras,
    onSuccess?: () => void,
  ) {
    const plugins = this.loadPlugins(configuration, tsConfigPath, appName);
    const forcePlugins = getValueOrDefault<boolean>(
      configuration,
      'compilerOptions.builder.options.forcePlugins',
      appName,
      undefined,
      [],
      false,
    );

    if (this.hasTransformerPlugins(plugins)) {
      if (forcePlugins) {
        console.warn(
          INFO_PREFIX +
            ' "tsgo.builder.options.forcePlugins" is enabled. Ignoring Nest compiler transformer hooks and using only "ReadonlyVisitor" hooks when available.',
        );
      } else {
        console.warn(
          INFO_PREFIX +
            ' "tsgo" does not support Nest compiler transformer plugins yet. Falling back to "tsc".',
        );
        return extras.fallbackToTsc();
      }
    }

    if (forcePlugins && plugins.readonlyVisitors.length === 0) {
      console.warn(
        INFO_PREFIX +
          ' "tsgo.builder.options.forcePlugins" is enabled, but no "ReadonlyVisitor" hooks were found. Configured transformer plugins will be ignored.',
      );
    }

    const pathToSource = this.getPathToSource(
      configuration,
      tsConfigPath,
      appName,
    );

    if (plugins.readonlyVisitors.length > 0) {
      this.generateMetadataOnce(
        tsConfigPath,
        pathToSource,
        plugins.readonlyVisitors,
      );

      if (extras.watch) {
        this.watchMetadata(tsConfigPath, pathToSource, plugins.readonlyVisitors);
      }
    }

    const args = ['-p', tsConfigPath];
    if (extras.watch) {
      args.unshift('--watch');
      await this.runInWatchMode(args, extras, onSuccess);
      return;
    }

    await this.runOnce(args);

    if (onSuccess) {
      onSuccess();
    }

    await extras.assetsManager.closeWatchers();
  }

  private async runOnce(args: string[]) {
    const childProcessRef = this.spawnTsgo(args);

    await new Promise<void>((resolve) => {
      childProcessRef.once('error', (err) => {
        console.error(ERROR_PREFIX + ` ${err.message}`);
        process.exit(1);
      });
      childProcessRef.once('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        process.exit(code ?? 1);
      });
    });
  }

  private async runInWatchMode(
    args: string[],
    extras: TsgoCompilerExtras,
    onSuccess?: () => void,
  ) {
    const childProcessRef = this.spawnTsgo(args);
    let shuttingDown = false;

    process.on('exit', () => {
      shuttingDown = true;
      if (childProcessRef.pid) {
        treeKillSync(childProcessRef.pid);
      }
    });

    childProcessRef.once('error', (err) => {
      console.error(ERROR_PREFIX + ` ${err.message}`);
      process.exit(1);
    });

    childProcessRef.once('close', (code, signal) => {
      if (shuttingDown) {
        return;
      }
      if (typeof code === 'number' && code !== 0) {
        process.exit(code);
      }
      if (signal) {
        process.exit(1);
      }
    });

    if (onSuccess) {
      const callback = this.debounce(onSuccess, 150);
      await this.watchFilesInOutDir(extras.tsOptions.outDir, callback);
    }
  }

  private generateMetadataOnce(
    tsConfigPath: string,
    outputDir: string,
    visitors: MultiNestCompilerPlugins['readonlyVisitors'],
  ) {
    const tsBinary = this.typescriptLoader.load();
    const { options, fileNames, projectReferences } =
      this.tsConfigProvider.getByConfigFilename(tsConfigPath);
    const createProgram =
      tsBinary.createIncrementalProgram ?? tsBinary.createProgram;
    const program = createProgram.call(ts, {
      rootNames: fileNames,
      projectReferences,
      options,
    });
    const programRef = program.getProgram
      ? program.getProgram()
      : (program as any as ts.Program);

    this.pluginMetadataGenerator.generate({
      outputDir,
      visitors,
      tsProgramRef: programRef,
    });
  }

  private watchMetadata(
    tsConfigPath: string,
    outputDir: string,
    visitors: MultiNestCompilerPlugins['readonlyVisitors'],
  ) {
    this.pluginMetadataGenerator.generate({
      outputDir,
      visitors,
      tsconfigPath: tsConfigPath,
      watch: true,
      printDiagnostics: false,
    });
  }

  private hasTransformerPlugins(plugins: MultiNestCompilerPlugins) {
    return (
      plugins.beforeHooks.length > 0 ||
      plugins.afterHooks.length > 0 ||
      plugins.afterDeclarationsHooks.length > 0
    );
  }

  private spawnTsgo(args: string[]) {
    return spawn(process.execPath, [this.resolveTsgoBinaryPath(), ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  }

  private resolveTsgoBinaryPath() {
    try {
      const packageJsonPath = require.resolve(
        '@typescript/native-preview/package.json',
        {
          paths: [join(process.cwd(), 'node_modules'), ...module.paths],
        },
      );
      return join(dirname(packageJsonPath), 'bin', 'tsgo.js');
    } catch {
      console.error(ERROR_PREFIX + ` ${CLI_ERRORS.MISSING_TSGO()}`);
      process.exit(1);
      throw new Error(CLI_ERRORS.MISSING_TSGO());
    }
  }

  private debounce(callback: () => void, wait: number) {
    let timeout: NodeJS.Timeout;
    return () => {
      clearTimeout(timeout);
      timeout = setTimeout(callback, wait);
    };
  }

  private async watchFilesInOutDir(
    outDir: string | undefined,
    onChange: () => void,
  ) {
    const dir = isAbsolute(outDir ?? defaultOutDir)
      ? (outDir ?? defaultOutDir)
      : join(process.cwd(), outDir ?? defaultOutDir);

    const watcher = chokidar.watch(dir, {
      ignored: (file, stats) =>
        (stats?.isFile() &&
          !(file.endsWith('.js') || file.endsWith('.mjs'))) as boolean,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    watcher.on('ready', () => {
      for (const type of ['add', 'change'] as const) {
        watcher.on(type, async () => onChange());
      }
    });
  }
}
