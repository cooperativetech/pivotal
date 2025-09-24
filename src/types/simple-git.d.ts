declare module 'simple-git' {
  export interface RemoteDescription {
    name: string
    refs: {
      fetch?: string
      push?: string
    }
  }

  export interface SimpleGit {
    status(): Promise<unknown>
    diff(options?: string[]): Promise<string>
    add(files: string | string[]): Promise<void>
    commit(message: string): Promise<void>
    push(remote?: string, branch?: string): Promise<void>
    getRemotes(detailed?: boolean): Promise<RemoteDescription[]>
    addRemote(name: string, repo: string): Promise<void>
    checkout(branch: string): Promise<void>
    pull(remote?: string, branch?: string): Promise<void>
    addConfig(key: string, value: string): Promise<void>
    init(): Promise<void>
  }

  export function simpleGit(baseDir?: string): SimpleGit
  export default simpleGit
}
