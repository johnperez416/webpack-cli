import { type IWebpackCLI } from "webpack-cli";

const WEBPACK_PACKAGE = process.env.WEBPACK_PACKAGE || "webpack";

class ConfigTestCommand {
  async apply(cli: IWebpackCLI): Promise<void> {
    await cli.makeCommand(
      {
        name: "configtest [config-path]",
        alias: "t",
        description: "Validate a webpack configuration.",
        pkg: "@webpack-cli/configtest",
        dependencies: [WEBPACK_PACKAGE],
      },
      [],
      async (configPath: string | undefined): Promise<void> => {
        cli.webpack = await cli.loadWebpack();

        const config = await cli.loadConfig(configPath ? { config: [configPath] } : {});
        const configPaths = new Set<string>();

        if (Array.isArray(config.options)) {
          for (const options of config.options) {
            const loadedConfigPaths = config.path.get(options);

            if (loadedConfigPaths) {
              for (const path of loadedConfigPaths) configPaths.add(path);
            }
          }
        } else if (config.path.get(config.options)) {
          const loadedConfigPaths = config.path.get(config.options);

          if (loadedConfigPaths) {
            for (const path of loadedConfigPaths) configPaths.add(path);
          }
        }

        if (configPaths.size === 0) {
          cli.logger.error("No configuration found.");
          process.exit(2);
        }

        cli.logger.info(`Validate '${[...configPaths].join(" ,")}'.`);

        try {
          cli.webpack.validate(config.options);
        } catch (error) {
          if (cli.isValidationError(error as Error)) {
            cli.logger.error((error as Error).message);
          } else {
            cli.logger.error(error);
          }

          process.exit(2);
        }

        cli.logger.success("There are no validation errors in the given webpack configuration.");
      },
    );
  }
}

export default ConfigTestCommand;
