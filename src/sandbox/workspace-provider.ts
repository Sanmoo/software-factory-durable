import { posix } from 'node:path';
import type { RealFSProvider } from '@earendil-works/gondolin';

type Constructor = new (root: string) => RealFSProvider;

/** Keep the native provider/FD implementation. SDK0.14 lstat/readlink validate
 * lexical containment only; additionally confine their ancestors via its public
 * realpath API. FsRpcService serializes guest requests, as required by path-based
 * providers. This does not protect against compromised trusted host processes. */
export function createWorkspaceProvider(Provider: Constructor, root: string): RealFSProvider {
  const provider = new Provider(root);
  const lstat = provider.lstat.bind(provider), lstatSync = provider.lstatSync.bind(provider);
  const readlink = provider.readlink.bind(provider), readlinkSync = provider.readlinkSync.bind(provider);
  const realpath = provider.realpath.bind(provider), realpathSync = provider.realpathSync.bind(provider);
  const parent = (path: string) => posix.dirname(posix.normalize(path));
  provider.lstat = async (path, options) => {
    await realpath(parent(path));
    return lstat(path, options);
  };
  provider.lstatSync = (path, options) => {
    realpathSync(parent(path));
    return lstatSync(path, options);
  };
  provider.readlink = async (path, options) => {
    await realpath(parent(path));
    return readlink(path, options);
  };
  provider.readlinkSync = (path, options) => {
    realpathSync(parent(path));
    return readlinkSync(path, options);
  };
  return provider;
}
