export const CLI_ERRORS = {
  MISSING_TYPESCRIPT: (path: string) =>
    `Could not find TypeScript configuration file "${path}". Please, ensure that you are running this command in the appropriate directory (inside Nest workspace).`,
  WRONG_PLUGIN: (name: string) =>
    `The "${name}" plugin is not compatible with Nest CLI. None of "after()", "before()", "afterDeclarations()", or "ReadonlyVisitor" have been provided.`,
  MISSING_TSGO: () =>
    'Failed to load "@typescript/native-preview" required package. Please, make sure to install it as a development dependency.',
};
