'use strict';

import * as core from '@serverless-devs/core';
import Docker from 'dockerode';
import { ServiceConfig, NasConfig } from '../interface/fc-service';
import { FunctionConfig } from '../interface/fc-function';
import { TriggerConfig } from '../interface/fc-trigger';
import { CustomDomainConfig } from '../interface/fc-custom-domain';
import * as path from 'path';
import * as _ from 'lodash';
import * as docker from '../docker/docker';
import logger from '../../common/logger';
import * as dockerOpts from '../docker/docker-opts';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import * as rimraf from 'rimraf';
import extract = require("extract-zip");
import tmpDir from 'temp-dir';
import { DEFAULT_NAS_PATH_SUFFIX } from '../devs';
import { isCustomContainerRuntime } from '../common/model/runtime';
import {writeDebugIdeConfigForVscode} from "../docker/docker";
import {ICredentials} from "../../common/entity";
import {isFalseValue} from "../utils/value";
import {isIgnored, isIgnoredInCodeUri} from "../ignore";
import * as fse from 'fs-extra';
import { genLayerCodeCachePath } from '../layer';



function isZipArchive(codeUri) {
  return codeUri ? codeUri.endsWith('.zip') || codeUri.endsWith('.jar') || codeUri.endsWith('.war') : false;
}

async function processZipCodeIfNecessary(codeUri: string): Promise<string> {

  if (!isZipArchive(codeUri)) { return null; }

  const tmpCodeDir: string = path.join(tmpDir, uuidv4());

  await fs.ensureDir(tmpCodeDir);

  logger.log(`codeUri is a zip format, will unzipping to ${tmpCodeDir}`);
  await extract(codeUri, { dir: tmpCodeDir });
  return tmpCodeDir;
}

export default class Invoke {
  protected baseDir: string;
  protected region: string;
  protected serviceName: string;
  protected functionName: string;
  protected serviceConfig: ServiceConfig;
  protected functionConfig: FunctionConfig;
  protected runtime: string;
  protected codeUri: string;
  protected containerName: string;
  protected imageName: string;
  protected triggerConfig?: TriggerConfig;
  protected customContainerConfigList?: CustomDomainConfig[];
  protected debugPort?: number;
  protected debugIde?: any;
  protected nasBaseDir?: string;
  protected tmpDir?: string;
  protected debuggerPath?: string;
  protected debugArgs?: any;
  protected inited?: boolean;
  protected nasConfig?: NasConfig;
  protected dockerUser?: any;
  protected nasMounts?: any;
  protected unzippedCodeDir?: string;
  protected codeMount?: any;
  protected tmpDirMount?: any;
  protected debuggerMount?: any;
  protected passwdMount?: any;
  protected layerMount: any;
  protected mounts?: any;
  protected nasMappingsMount? : any;
  protected creds: ICredentials;
  protected fcCore: any;

  constructor(creds, region: string, baseDir: string, serviceConfig: ServiceConfig, functionConfig: FunctionConfig, triggerConfig?: TriggerConfig, debugPort?: number, debugIde?: any, tmpDir?: string, debuggerPath?: string, debugArgs?: any, nasBaseDir?: string) {
    this.creds = creds;
    this.region = region;
    this.serviceName = serviceConfig.name;
    this.serviceConfig = serviceConfig;
    this.functionName = functionConfig.name;
    this.functionConfig = functionConfig;
    this.triggerConfig = triggerConfig;
    this.debugPort = debugPort;
    this.debugIde = debugIde;
    this.nasBaseDir = nasBaseDir;

    this.runtime = this.functionConfig.runtime;
    this.baseDir = baseDir;
    this.codeUri = this.functionConfig.codeUri ? path.resolve(this.baseDir, this.functionConfig.codeUri) : null;
    this.tmpDir = tmpDir;
    this.debuggerPath = debuggerPath;
    this.debugArgs = debugArgs;
  }

  async invoke(req, res) {
    if (!this.inited) {
      await this.init();
    }

    await this.beforeInvoke();
    await this.setDebugIdeConfig();
    // @ts-ignore
    await this.doInvoke(req, res);
    await this.afterInvoke();
  }

  async init() {
    this.fcCore = await core.loadComponent('devsapp/fc-core');
    this.nasConfig = this.serviceConfig?.nasConfig;
    this.dockerUser = await dockerOpts.resolveDockerUser({ nasConfig: this.nasConfig });
    this.nasMounts = await docker.resolveNasConfigToMounts(this.baseDir, this.serviceName, this.nasConfig, this.nasBaseDir || path.join(this.baseDir, DEFAULT_NAS_PATH_SUFFIX));
    this.unzippedCodeDir = await processZipCodeIfNecessary(this.codeUri);
    this.codeMount = await docker.resolveCodeUriToMount(this.unzippedCodeDir || this.codeUri);
    // TODO: 支持 nas mapping yaml file
    // this.nasMappingsMount = await docker.resolveNasYmlToMount(this.baseDir, this.serviceName);
    this.tmpDirMount = (!process.env.DISABLE_BIND_MOUNT_TMP_DIR || isFalseValue(process.env.DISABLE_BIND_MOUNT_TMP_DIR)) ? await docker.resolveTmpDirToMount(this.tmpDir) : null;
    this.debuggerMount = await docker.resolveDebuggerPathToMount(this.debuggerPath);
    this.passwdMount = await docker.resolvePasswdMount();

    // 支持 layer
    if (!_.isEmpty(this.functionConfig.layers)) {
      const layerCachePath = genLayerCodeCachePath(this.baseDir, this.serviceName, this.functionName);
      this.layerMount = docker.resolveLayerToMounts(layerCachePath);
    }

    // const allMount = _.compact([this.codeMount, ...this.nasMounts, ...this.nasMappingsMount, this.passwdMount]);
    const allMount = _.compact([this.codeMount, ...this.nasMounts, this.passwdMount]);

    if (!_.isEmpty(this.layerMount)) {
      allMount.push(this.layerMount);
    }

    if (!_.isEmpty(this.tmpDirMount)) {
      allMount.push(this.tmpDirMount);
    }

    if (!_.isEmpty(this.debuggerMount)) {
      allMount.push(this.debuggerMount);
    }

    const isDockerToolBox = await docker.isDockerToolBoxAndEnsureDockerVersion();

    if (isDockerToolBox) {
      this.mounts = dockerOpts.transformMountsForToolbox(allMount);
    } else {
      this.mounts = allMount;
    }

    logger.debug(`docker mounts: ${JSON.stringify(this.mounts, null, 4)}`);

    this.containerName = docker.generateRamdomContainerName();
    const isCustomContainer = isCustomContainerRuntime(this.runtime);
    if (isCustomContainer) {
      this.imageName = this.functionConfig.customContainerConfig.image;
    } else {
      this.imageName = await dockerOpts.resolveRuntimeToDockerImage(this.runtime);
    }
    await this.fcCore.pullImageIfNeed(new Docker(), this.imageName);
    this.inited = true;
  }

  async beforeInvoke() {

  }

  async setDebugIdeConfig() {
    if (this.debugPort && this.debugIde) {
      if (this.debugIde.toLowerCase() === 'vscode') {
        // try to write .vscode/config.json
        await writeDebugIdeConfigForVscode(this.baseDir, this.serviceName, this.functionName, this.runtime, this.functionConfig?.originalCodeUri ? path.join(this.baseDir, this.functionConfig.originalCodeUri) : null, this.debugPort);
      } else if (this.debugIde.toLowerCase() === 'pycharm') {
        await docker.showDebugIdeTipsForPycharm(this.functionConfig?.originalCodeUri ? path.join(this.baseDir, this.functionConfig.originalCodeUri) : null, this.debugPort);
      }
    }
  }

  public cleanUnzippedCodeDir() {
    if (this.unzippedCodeDir) {
      rimraf.sync(this.unzippedCodeDir);
      console.log(`clean tmp code dir ${this.unzippedCodeDir} successfully`);
      this.unzippedCodeDir = null;
    }
  }

  async afterInvoke() {
    this.cleanUnzippedCodeDir();
  }

  async getCodeIgnore(): Promise<Function> {
    const ignoreFileInCodeUri: string = path.join(path.resolve(this.baseDir, this.functionConfig?.codeUri), '.fcignore');
    if (fse.pathExistsSync(ignoreFileInCodeUri) && fse.lstatSync(ignoreFileInCodeUri).isFile()) {
      return await isIgnoredInCodeUri(path.resolve(this.baseDir, this.functionConfig?.codeUri), this.runtime);
    }
    const ignoreFileInBaseDir: string = path.join(this.baseDir, '.fcignore');
    if (fse.pathExistsSync(ignoreFileInBaseDir) && fse.lstatSync(ignoreFileInBaseDir).isFile()) {
      logger.warn('.fcignore file will be placed under codeUri only in the future. Please update it with the relative path and then move it to the codeUri as soon as possible.');
    }
    return await isIgnored(this.baseDir, this.runtime, path.resolve(this.baseDir, this.functionConfig?.codeUri), path.resolve(this.baseDir, this.functionConfig?.originalCodeUri || this.functionConfig?.codeUri));
  }
}
