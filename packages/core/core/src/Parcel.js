// @flow

import type {InitialParcelOptions, ParcelOptions, Stats} from '@parcel/types';
import type {Bundle} from './types';
import type InternalBundleGraph from './BundleGraph';

import {Asset} from './public/Asset';
import {BundleGraph} from './public/BundleGraph';
import BundlerRunner from './BundlerRunner';
import WorkerFarm from '@parcel/workers';
import nullthrows from 'nullthrows';
import clone from 'clone';
import Cache from '@parcel/cache';
import watcher from '@parcel/watcher';
import path from 'path';
import AssetGraphBuilder, {BuildAbortError} from './AssetGraphBuilder';
import ConfigResolver from './ConfigResolver';
import ReporterRunner from './ReporterRunner';
import MainAssetGraph from './public/MainAssetGraph';
import dumpGraphToGraphViz from './dumpGraphToGraphViz';
import resolveOptions from './resolveOptions';

export default class Parcel {
  #assetGraphBuilder; // AssetGraphBuilder
  #bundlerRunner; // BundlerRunner
  #farm; // WorkerFarm
  #initialized = false; // boolean
  #initialOptions; // InitialParcelOptions;
  #reporterRunner; // ReporterRunner
  #resolvedOptions; // ?ParcelOptions
  #runPackage; // (bundle: Bundle) => Promise<Stats>;
  #watcher;

  constructor(options: InitialParcelOptions) {
    this.#initialOptions = clone(options);
  }

  async init(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    let resolvedOptions: ParcelOptions = await resolveOptions(
      this.#initialOptions
    );
    this.#resolvedOptions = resolvedOptions;
    await Cache.createCacheDir(resolvedOptions.cacheDir);

    let configResolver = new ConfigResolver();
    let config;

    // If an explicit `config` option is passed use that, otherwise resolve a .parcelrc from the filesystem.
    if (resolvedOptions.config) {
      config = await configResolver.create(resolvedOptions.config);
    } else {
      config = await configResolver.resolve(resolvedOptions.rootDir);
    }

    // If no config was found, default to the `defaultConfig` option if one is provided.
    if (!config && resolvedOptions.defaultConfig) {
      config = await configResolver.create(resolvedOptions.defaultConfig);
    }

    if (!config) {
      throw new Error('Could not find a .parcelrc');
    }

    this.#bundlerRunner = new BundlerRunner({
      options: resolvedOptions,
      config
    });

    this.#reporterRunner = new ReporterRunner({
      config,
      options: resolvedOptions
    });

    this.#assetGraphBuilder = new AssetGraphBuilder({
      options: resolvedOptions,
      config,
      entries: resolvedOptions.entries,
      targets: resolvedOptions.targets
    });

    this.#farm = await WorkerFarm.getShared(
      {
        config,
        options: resolvedOptions,
        env: resolvedOptions.env
      },
      {
        workerPath: require.resolve('./worker')
      }
    );

    this.#runPackage = this.#farm.mkhandle('runPackage');

    await this.initializeWatcher();
  }

  async initializeWatcher() {
    // TODO: get project root programmatically
    // it should probably be where the lock file is found or process.cwd if no lockfile is found
    // we may end up needing this location for other things, in which case it would be named projectRoot and held in ParcelOptions
    // ? Do we need to distinguish between vsc root and project root? They may not always be the same.
    let projectRoot = process.cwd();
    if (this.#resolvedOptions.watch) {
      // TODO: ideally these should all be absolute paths already set up on #resolvedOptions
      let targetDirs = this.#resolvedOptions.targets.map(target =>
        path.resolve(process.cwd(), target.distDir)
      );
      let cacheDir = path.resolve(
        process.cwd(),
        this.#resolvedOptions.cacheDir
      );
      let vcsDirs = ['.git', '.hg'].map(dir => path.join(projectRoot, dir));
      let ignore = [cacheDir, ...targetDirs, ...vcsDirs];
      this.#watcher = await watcher.subscribe(
        projectRoot,
        (err, events) => {
          if (err) {
            throw err;
          }

          this.#assetGraphBuilder.respondToFSEvents(events);
          if (this.#assetGraphBuilder.isInvalid()) {
            this.build().catch(() => {
              // Do nothing, in watch mode reporters should alert the user something is broken, which
              // allows Parcel to gracefully continue once the user makes the correct changes
            });
          }
        },
        {ignore}
      );
    }

    this.#initialized = true;
  }

  // `run()` returns `Promise<?BundleGraph>` because in watch mode it does not
  // return a bundle graph, but outside of watch mode it always will.
  async run(): Promise<?BundleGraph> {
    if (!this.#initialized) {
      await this.init();
    }

    let resolvedOptions = nullthrows(this.#resolvedOptions);
    try {
      let graph = await this.build();
      if (!resolvedOptions.watch) {
        return graph;
      }
    } catch (e) {
      if (!resolvedOptions.watch) {
        throw e;
      }
    }
  }

  async build(): Promise<BundleGraph> {
    try {
      this.#reporterRunner.report({
        type: 'buildStart'
      });

      let startTime = Date.now();
      let {assetGraph, changedAssets} = await this.#assetGraphBuilder.build();
      dumpGraphToGraphViz(assetGraph, 'MainAssetGraph');

      let bundleGraph = await this.#bundlerRunner.bundle(assetGraph);
      dumpGraphToGraphViz(bundleGraph, 'BundleGraph');

      await packageBundles(bundleGraph, this.#runPackage);

      this.#reporterRunner.report({
        type: 'buildSuccess',
        changedAssets: new Map(
          Array.from(changedAssets).map(([id, asset]) => [id, new Asset(asset)])
        ),
        assetGraph: new MainAssetGraph(assetGraph),
        bundleGraph: new BundleGraph(bundleGraph),
        buildTime: Date.now() - startTime
      });

      let resolvedOptions = nullthrows(this.#resolvedOptions);
      if (!resolvedOptions.watch && resolvedOptions.killWorkers !== false) {
        await this.#farm.end();
      }

      return new BundleGraph(bundleGraph);
    } catch (e) {
      if (!(e instanceof BuildAbortError)) {
        await this.#reporterRunner.report({
          type: 'buildFailure',
          error: e
        });
      }

      throw new BuildError(e);
    }
  }
}

function packageBundles(
  bundleGraph: InternalBundleGraph,
  runPackage: (bundle: Bundle) => Promise<Stats>
): Promise<mixed> {
  let promises = [];
  bundleGraph.traverseBundles(bundle => {
    promises.push(
      runPackage(bundle).then(stats => {
        bundle.stats = stats;
      })
    );
  });

  return Promise.all(promises);
}

export class BuildError extends Error {
  name = 'BuildError';
  error: mixed;

  constructor(error: mixed) {
    super(error instanceof Error ? error.message : 'Unknown Build Error');
    this.error = error;
  }
}

export {default as Asset} from './Asset';
export {default as Dependency} from './Dependency';
export {default as Environment} from './Environment';
