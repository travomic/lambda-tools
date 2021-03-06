const build = require('../src/webpack');
const fs = require('fs-extra');
const JSZip = require('jszip');
const path = require('path');
const sinon = require('sinon');
const test = require('ava');
const uuid = require('uuid/v4');
const {createLambdaExecutionEnvironment, destroyLambdaExecutionEnvironment, LambdaRunner} = require('../src/lambda');

const SUPPORTED_NODE_VERSIONS = ['6.10', '8.10'];

test.beforeEach((test) => {
  test.context.buildDirectory = path.join(__dirname, 'fixtures', 'build', uuid());
});

test.afterEach(() => {
  sinon.restore();
});

test.always.afterEach((test) => fs.remove(test.context.buildDirectory));

test('Setting WEBPACK_MODE to development disables minification', async (test) => {
  const source = path.join(__dirname, 'fixtures', 'lambda_service.js');
  const bundle = path.join(test.context.buildDirectory, 'lambda_service.js');

  let buildResults = await build({
    entrypoint: source,
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(buildResults.hasErrors());

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const minifiedSize = (await fs.stat(bundle)).size;

  process.env.WEBPACK_MODE = 'development';
  try {
    buildResults = await build({
      entrypoint: source,
      outputPath: test.context.buildDirectory,
      serviceName: 'test-service'
    });
    test.false(buildResults.hasErrors());
  } finally {
    delete process.env.WEBPACK_MODE;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fullSize = (await fs.stat(bundle)).size;
  test.true(fullSize > minifiedSize);
});

test('The webpack configuration can be transformed', async (test) => {
  const source = path.join(__dirname, 'fixtures', 'lambda_service.js');
  const bundle = path.join(test.context.buildDirectory, 'lambda_service.js');

  const transformer = sinon.stub().callsFake(function (config) {
    config.externals['koa-router'] = 'koa-router';
    return config;
  });

  const buildResultExternalKoaRouter = await build({
    configTransformer: transformer,
    entrypoint: source,
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(buildResultExternalKoaRouter.hasErrors());

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const webpackedContents = await fs.readFile(bundle, 'utf8');
  // Make sure that koa-router is really treated as external as the transformed config would require
  test.truthy(/e\.exports=require\("koa-router"\)/.test(webpackedContents));

  sinon.assert.calledOnce(transformer);
  sinon.assert.calledWith(transformer, sinon.match.object);
});

test('Typescript bundles are supported by default', async (test) => {
  const source = path.join(__dirname, 'fixtures', 'ts_lambda_service.ts');

  const result = await build({
    entrypoint: source,
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(result.hasErrors());

  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'ts_lambda_service.js')));
  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'ts_lambda_service.js.map')));
});

test('Node 6 bundles are produced by default', async (test) => {
  const source = path.join(__dirname, 'fixtures', 'lambda_service.js');

  const transformer = sinon.stub().returnsArg(0);

  const result = await build({
    configTransformer: transformer,
    entrypoint: source,
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(result.hasErrors());

  sinon.assert.calledOnce(transformer);
  sinon.assert.calledWithExactly(transformer, sinon.match.object);

  const config = transformer.firstCall.args[0];
  const babel = config.module.rules.find((rule) => rule.loader === 'babel-loader');
  test.is(babel.options.presets[0][1].targets.node, '6.10');
});

test('A custom Node version can be used', async (test) => {
  const source = path.join(__dirname, 'fixtures', 'lambda_service.js');

  const nodeVersion = '8.10';
  const transformer = sinon.stub().returnsArg(0);

  const result = await build({
    configTransformer: transformer,
    entrypoint: source,
    nodeVersion,
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(result.hasErrors());

  sinon.assert.calledOnce(transformer);
  sinon.assert.calledWithExactly(transformer, sinon.match.object);

  const config = transformer.firstCall.args[0];
  const babel = config.module.rules.find((rule) => rule.loader === 'babel-loader');
  test.is(babel.options.presets[0][1].targets.node, nodeVersion);
});

test('Lambda archives can be produced', async (test) => {
  const source = path.join(__dirname, 'fixtures', 'lambda_service.js');
  const bundle = path.join(test.context.buildDirectory, 'lambda_service.js.zip');

  const buildResults = await build({
    entrypoint: source,
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service',
    zip: true
  });
  test.false(buildResults.hasErrors());

  const zip = new JSZip();
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await zip.loadAsync(await fs.readFile(bundle));
  test.truthy(zip.file('lambda_service.js'));
});

test('Multiple bundles can be produced at one time', async (test) => {
  const buildResults = await build({
    entrypoint: [
      path.join(__dirname, 'fixtures', 'lambda_graphql.js'),
      path.join(__dirname, 'fixtures', 'lambda_service.js')
    ],
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(buildResults.hasErrors());

  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'lambda_graphql.js')));
  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'lambda_service.js')));
});

test('Multiple bundles can be produced with mixed source types', async (test) => {
  const buildResults = await build({
    entrypoint: [
      path.join(__dirname, 'fixtures', 'lambda_service.js'),
      path.join(__dirname, 'fixtures', 'ts_lambda_service.ts')
    ],
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(buildResults.hasErrors());

  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'lambda_service.js')));
  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'ts_lambda_service.js')));
});

test('Bundles can use custom names', async (test) => {
  const buildResults = await build({
    entrypoint: [
      path.join(__dirname, 'fixtures', 'lambda_graphql.js:graphql.js'),
      path.join(__dirname, 'fixtures', 'lambda_service.js:lambda/service.js')
    ],
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service'
  });
  test.false(buildResults.hasErrors());

  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'graphql.js')));
  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'lambda', 'service.js')));
});

test('Bundles for multiple entries can be zipped', async (test) => {
  await build({
    entrypoint: [
      path.join(__dirname, 'fixtures', 'lambda_graphql.js:graphql.js'),
      path.join(__dirname, 'fixtures', 'lambda_service.js:lambda/service.js')
    ],
    outputPath: test.context.buildDirectory,
    serviceName: 'test-service',
    zip: true
  });

  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'graphql.js.zip')));
  test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'lambda/service.js.zip')));
});

test.serial('Expand input entrypoint directory into multiple entrypoints', async (test) => {
  const multiLambdasDir = path.join(__dirname, 'fixtures/multi-lambdas');
  const emptyDir = path.join(multiLambdasDir, `empty-${uuid()}`);
  await fs.mkdirp(emptyDir);

  const originalFsStat = fs.stat;
  const unreadableFile = path.join(multiLambdasDir, 'unreadable/index.js');

  const stubStat = sinon.stub(fs, 'stat').callsFake(function (file) {
    if (file === unreadableFile) {
      throw new Error('Simulated unreadable');
    }

    return originalFsStat(file);
  });

  try {
    await build({
      entrypoint: [
        multiLambdasDir
      ],
      outputPath: test.context.buildDirectory,
      serviceName: 'test-service',
      zip: true
    });

    sinon.assert.calledWith(stubStat, unreadableFile);

    test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'func1.js.zip')));
    test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'func2.js.zip')));
    test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'func3.js.zip')));
    test.true(await fs.pathExists(path.join(test.context.buildDirectory, 'func4.js.zip')));
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.rmdir(emptyDir);
  }
});

test.serial('Bundles are produced in the current working directory by default', async (test) => {
  const cwd = process.cwd();
  await fs.ensureDir(test.context.buildDirectory);

  try {
    process.chdir(test.context.buildDirectory);
    const buildResults = await build({
      entrypoint: path.join(__dirname, 'fixtures', 'lambda_service.js'),
      serviceName: 'test-service'
    });
    test.false(buildResults.hasErrors());

    test.true(await fs.pathExists('lambda_service.js'));
  } finally {
    process.chdir(cwd);
  }
});

test.serial('Should handle building entrypoint outside of current working directory', async (test) => {
  const cwd = process.cwd();

  try {
    process.chdir(path.join(__dirname, '../src'));
    const buildResults = await build({
      outputPath: test.context.buildDirectory,
      entrypoint: path.join(__dirname, 'fixtures', 'lambda_service.js'),
      serviceName: 'test-service',
      zip: true
    });
    test.false(buildResults.hasErrors());
  } finally {
    process.chdir(cwd);
  }
});

for (const nodeVersion of SUPPORTED_NODE_VERSIONS) {
  // Test that a common pattern can be packed without a regression
  test.serial(`Can webpack files that use await inside for...of statements targetting ${nodeVersion}`, async (test) => {
    const source = path.join(__dirname, 'fixtures', 'async_test.js');

    const result = await build({
      nodeVersion,
      entrypoint: source,
      outputPath: test.context.buildDirectory,
      serviceName: 'test-service'
    });
    test.false(result.hasErrors());
  });

  test.serial(`Can webpack files that use arrow functions inside async functions when targetting ${nodeVersion}`, async (test) => {
    const source = path.join(__dirname, 'fixtures', 'async_with_arrow.js');

    const result = await build({
      nodeVersion,
      entrypoint: source,
      outputPath: test.context.buildDirectory,
      serviceName: 'test-service'
    });
    test.false(result.hasErrors());

    // Try loading the newly loaded file to make sure it can
    // execute without an error
    const executionEnvironment = await createLambdaExecutionEnvironment({
      image: `lambci/lambda:nodejs${nodeVersion}`,
      mountpoint: test.context.buildDirectory
    });
    try {
      const runner = new LambdaRunner(executionEnvironment.container.id, 'async_with_arrow.handle');
      const result = await runner.invoke({});
      test.deepEqual(result, {});
    } finally {
      await destroyLambdaExecutionEnvironment(executionEnvironment);
    }
  });

  // Test that EJS modules can be packed because they are used by graphql
  test.serial(`Can webpack modules that use .mjs modules when targetting ${nodeVersion}`, async (test) => {
    const source = path.join(__dirname, 'fixtures', 'es_modules/index.js');

    const result = await build({
      nodeVersion,
      entrypoint: source,
      outputPath: test.context.buildDirectory,
      serviceName: 'test-service'
    });

    test.false(result.hasErrors());
  });
}
