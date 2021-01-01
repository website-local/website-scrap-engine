// subset of https://en.wikipedia.org/wiki/List_of_URI_schemes
export const unProcessableUriSchemes = [
  // Official IANA-registered schemes
  'about',
  'attachment',
  'blob',
  'cap',
  'chrome',
  'chrome-extension',
  'cid',
  'content',
  'cvs',
  'data',
  'dav',
  'dns',
  'drm',
  'ed2k',
  'example',
  'feed',
  'file',
  'filesystem',
  'ftp',
  'geo',
  'git',
  'icon',
  'im',
  'imap',
  'info',
  'ipn',
  'ipp',
  'ipps',
  'irc',
  'irc6',
  'ircs',
  'jar',
  'ldap',
  'ldaps',
  'magnet',
  'mailserver',
  'mailto',
  'maps',
  'market',
  'message',
  'mid',
  'mms',
  'modem',
  'ms-help',
  'ms-settings',
  'mvn',
  'news',
  'nfs',
  'oid',
  'pkcs11',
  'platform',
  'pop',
  'redis',
  'rediss',
  'res',
  'resource',
  'rmi',
  'rsync',
  'rtmfp',
  'rtmp',
  'rtsp',
  's3',
  'service',
  'sftp',
  'shttp',
  'sip',
  'sips',
  'skype',
  'smb',
  'sms',
  'snews',
  'snmp',
  'spotify',
  'ssh',
  'steam',
  'svn',
  'tag',
  'tel',
  'telnet',
  'tftp',
  'udp',
  'unreal',
  'urn',
  'view-source',
  'vnc',
  'ws',
  'wss',
  'xri',
  // Unofficial but common URI schemes
  'admin',
  'app',
  'javascript',
  'jdbc',
  'odbc',
  // Unix sockets is supported by got, but not yet supported here
  'unix'
];

export const fastUnProcessableUriSchemesMap: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (let i = 0, item, l = unProcessableUriSchemes.length; i < l; i++) {
    item = unProcessableUriSchemes[i];
    if (map[item[0]]) {
      map[item[0]].push(item);
    } else {
      map[item[0]] = [item];
    }
  }
  return map;
})();

/**
 * Skip unprocessable links
 */
export function skipLinks(url: string): string | void {
  if (url.startsWith('#')) {
    return;
  }
  const unProcessableUriSchemeList = fastUnProcessableUriSchemesMap[url[0]];
  if (unProcessableUriSchemeList && unProcessableUriSchemeList.length) {
    for (let i = 0, item, il, l = unProcessableUriSchemeList.length; i < l; i++) {
      item = unProcessableUriSchemeList[i];
      il = item.length;
      if (url.length > il && url.startsWith(item) && url[il] === ':') {
        return;
      }
    }
  }
  return url;
}
