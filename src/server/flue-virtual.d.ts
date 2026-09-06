declare module 'virtual:flue/server' {
  export function loadFlueNodeApplication(): Promise<
    import('./listeners').HostedApplication
  >;
}
