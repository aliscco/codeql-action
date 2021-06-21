import * as fs from "fs";
import * as path from "path";

import * as core from "@actions/core";

import * as actionsUtil from "./actions-util";
import {
  runAnalyze,
  CodeQLAnalysisError,
  QueriesStatusReport,
  runCleanup,
} from "./analyze";
import { getApiClient, GitHubApiDetails } from "./api-client";
import { getCodeQL } from "./codeql";
import { Config, getConfig } from "./config-utils";
import { getActionsLogger, Logger } from "./logging";
import { parseRepositoryNwo, RepositoryNwo } from "./repository";
import * as upload_lib from "./upload-lib";
import * as util from "./util";

// eslint-disable-next-line import/no-commonjs
const pkg = require("../package.json");

interface AnalysisStatusReport
  extends upload_lib.UploadStatusReport,
    QueriesStatusReport {}

interface FinishStatusReport
  extends actionsUtil.StatusReportBase,
    AnalysisStatusReport {}

async function sendStatusReport(
  startedAt: Date,
  stats: AnalysisStatusReport | undefined,
  error?: Error
) {
  const status =
    stats?.analyze_failure_language !== undefined || error !== undefined
      ? "failure"
      : "success";
  const statusReportBase = await actionsUtil.createStatusReportBase(
    "finish",
    status,
    startedAt,
    error?.message,
    error?.stack
  );
  const statusReport: FinishStatusReport = {
    ...statusReportBase,
    ...(stats || {}),
  };
  await actionsUtil.sendStatusReport(statusReport);
}

async function uploadDatabases(
  repositoryNwo: RepositoryNwo,
  config: Config,
  apiDetails: GitHubApiDetails,
  logger: Logger
): Promise<void> {
  if (actionsUtil.getRequiredInput("upload-database") !== "true") {
    logger.debug("Database upload disabled in workflow. Skipping upload.");
    return;
  }

  // Do nothing when not running against github.com
  if (config.gitHubVersion.type !== util.GitHubVariant.DOTCOM) {
    logger.debug("Not running against github.com. Skipping upload.");
    return;
  }

  if (!(await actionsUtil.isAnalyzingDefaultBranch())) {
    // We only want to upload a database if we are analyzing the default branch.
    logger.debug("Not analyzing default branch. Skipping upload.");
    return;
  }

  const client = getApiClient(apiDetails);
  try {
    await client.request("GET /repos/:owner/:repo/code-scanning/databases", {
      owner: repositoryNwo.owner,
      repo: repositoryNwo.repo,
    });
  } catch (e) {
    if (util.isHTTPError(e) && e.status === 404) {
      logger.debug(
        "Repository is not opted in to database uploads. Skipping upload."
      );
    } else {
      console.log(e);
      logger.info(`Skipping database upload due to unknown error: ${e}`);
    }
    return;
  }

  const codeql = getCodeQL(config.codeQLCmd);
  for (const language of config.languages) {
    // Bundle the database up into a single zip file
    const databasePath = util.getCodeQLDatabasePath(config, language);
    const databaseBundlePath = `${databasePath}.zip`;
    await codeql.databaseBundle(databasePath, databaseBundlePath);

    // Upload the database bundle
    const payload = fs.readFileSync(databaseBundlePath);
    try {
      await client.request(
        `PUT /repos/:owner/:repo/code-scanning/databases/${language}`,
        {
          owner: repositoryNwo.owner,
          repo: repositoryNwo.repo,
          data: payload,
        }
      );
      logger.debug(`Successfully uploaded database for ${language}`);
    } catch (e) {
      console.log(e);
      // Log a warning but don't fail the workflow
      logger.warning(`Failed to upload database for ${language}: ${e}`);
    }
  }
}

async function run() {
  const startedAt = new Date();
  let stats: AnalysisStatusReport | undefined = undefined;
  let config: Config | undefined = undefined;
  util.initializeEnvironment(util.Mode.actions, pkg.version);

  try {
    if (
      !(await actionsUtil.sendStatusReport(
        await actionsUtil.createStatusReportBase(
          "finish",
          "starting",
          startedAt
        )
      ))
    ) {
      return;
    }
    const logger = getActionsLogger();
    config = await getConfig(actionsUtil.getTemporaryDirectory(), logger);
    if (config === undefined) {
      throw new Error(
        "Config file could not be found at expected location. Has the 'init' action been called?"
      );
    }

    const apiDetails = {
      auth: actionsUtil.getRequiredInput("token"),
      url: util.getRequiredEnvParam("GITHUB_SERVER_URL"),
    };
    const outputDir = actionsUtil.getRequiredInput("output");
    const queriesStats = await runAnalyze(
      outputDir,
      util.getMemoryFlag(actionsUtil.getOptionalInput("ram")),
      util.getAddSnippetsFlag(actionsUtil.getRequiredInput("add-snippets")),
      util.getThreadsFlag(actionsUtil.getOptionalInput("threads"), logger),
      actionsUtil.getOptionalInput("category"),
      config,
      logger
    );

    if (actionsUtil.getOptionalInput("cleanup-level") !== "none") {
      await runCleanup(
        config,
        actionsUtil.getOptionalInput("cleanup-level") || "brutal",
        logger
      );
    }

    const dbLocations: { [lang: string]: string } = {};
    for (const language of config.languages) {
      dbLocations[language] = util.getCodeQLDatabasePath(config, language);
    }
    core.setOutput("db-locations", dbLocations);

    if (actionsUtil.getRequiredInput("upload") === "true") {
      const uploadStats = await upload_lib.uploadFromActions(
        outputDir,
        config.gitHubVersion,
        apiDetails,
        logger
      );
      stats = { ...queriesStats, ...uploadStats };
    } else {
      logger.info("Not uploading results");
      stats = { ...queriesStats };
    }

    const repositoryNwo = parseRepositoryNwo(
      util.getRequiredEnvParam("GITHUB_REPOSITORY")
    );
    await uploadDatabases(repositoryNwo, config, apiDetails, logger);
  } catch (error) {
    core.setFailed(error.message);
    console.log(error);

    if (error instanceof CodeQLAnalysisError) {
      stats = { ...error.queriesStatusReport };
    }

    await sendStatusReport(startedAt, stats, error);
    return;
  } finally {
    if (core.isDebug() && config !== undefined) {
      core.info("Debug mode is on. Printing CodeQL debug logs...");
      for (const language of config.languages) {
        const databaseDirectory = util.getCodeQLDatabasePath(config, language);
        const logsDirectory = path.join(databaseDirectory, "log");

        const walkLogFiles = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              core.startGroup(
                `CodeQL Debug Logs - ${language} - ${entry.name}`
              );
              process.stdout.write(
                fs.readFileSync(path.resolve(dir, entry.name))
              );
              core.endGroup();
            } else if (entry.isDirectory()) {
              walkLogFiles(path.resolve(dir, entry.name));
            }
          }
        };
        walkLogFiles(logsDirectory);
      }
    }
  }

  await sendStatusReport(startedAt, stats);
}

async function runWrapper() {
  try {
    await run();
  } catch (error) {
    core.setFailed(`analyze action failed: ${error}`);
    console.log(error);
  }
}

void runWrapper();
