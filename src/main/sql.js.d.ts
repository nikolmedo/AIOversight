declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer) => {
      exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
      close: () => void;
    };
  }
  function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
  export default initSqlJs;
}

declare module 'sql.js/dist/sql-wasm.wasm' {
  const path: string;
  export default path;
}
