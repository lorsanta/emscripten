/**
 * @license
 * Copyright 2013 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

addToLibrary({
#if WASMFS
  $NODEFS__deps: ['$stringToUTF8OnStack', 'wasmfs_create_node_backend'],
  $NODEFS: {
    createBackend(opts) {
      return _wasmfs_create_node_backend(stringToUTF8OnStack(opts.root));
    }
  }
#else
  $NODEFS__deps: ['$FS', '$PATH', '$ERRNO_CODES', '$mmapAlloc'],
  $NODEFS__postset: 'if (ENVIRONMENT_IS_NODE) { NODEFS.staticInit(); }',
  $NODEFS: {
    isWindows: false,
    staticInit() {
      NODEFS.isWindows = !!process.platform.match(/^win/);
      var flags = process.binding("constants")["fs"];
      NODEFS.flagsForNodeMap = {
        "{{{ cDefs.O_APPEND }}}": flags["O_APPEND"],
        "{{{ cDefs.O_CREAT }}}": flags["O_CREAT"],
        "{{{ cDefs.O_EXCL }}}": flags["O_EXCL"],
        "{{{ cDefs.O_NOCTTY }}}": flags["O_NOCTTY"],
        "{{{ cDefs.O_RDONLY }}}": flags["O_RDONLY"],
        "{{{ cDefs.O_RDWR }}}": flags["O_RDWR"],
        "{{{ cDefs.O_DSYNC }}}": flags["O_SYNC"],
        "{{{ cDefs.O_TRUNC }}}": flags["O_TRUNC"],
        "{{{ cDefs.O_WRONLY }}}": flags["O_WRONLY"],
        "{{{ cDefs.O_NOFOLLOW }}}": flags["O_NOFOLLOW"],
      };
#if ASSERTIONS
      // The 0 define must match on both sides, as otherwise we would not
      // know to add it.
      assert(NODEFS.flagsForNodeMap["0"] === 0);
#endif
    },
    convertNodeCode(e) {
      var code = e.code;
#if ASSERTIONS
      assert(code in ERRNO_CODES, `unexpected node error code: ${code} (${e})`);
#endif
      return ERRNO_CODES[code];
    },
    tryFSOperation(f) {
      try {
        return f();
      } catch (e) {
        if (!e.code) throw e;
        // node under windows can return code 'UNKNOWN' here:
        // https://github.com/emscripten-core/emscripten/issues/15468
        if (e.code === 'UNKNOWN') throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        throw new FS.ErrnoError(NODEFS.convertNodeCode(e));
      }
    },
    mount(mount) {
#if ASSERTIONS
      assert(ENVIRONMENT_IS_NODE);
#endif
      return NODEFS.createNode(null, '/', NODEFS.getMode(mount.opts.root), 0);
    },
    createNode(parent, name, mode, dev) {
      if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      var node = FS.createNode(parent, name, mode);
      node.node_ops = NODEFS.node_ops;
      node.stream_ops = NODEFS.stream_ops;
      return node;
    },
    getMode(path) {
      return NODEFS.tryFSOperation(() => {
        var mode = fs.lstatSync(path).mode;
        if (NODEFS.isWindows) {
          // Windows does not report the 'x' permission bit, so propagate read
          // bits to execute bits.
          mode |= (mode & {{{ cDefs.S_IRUGO }}}) >> 2;
        }
        return mode;
      });
    },
    realPath(node) {
      var parts = [];
      while (node.parent !== node) {
        parts.push(node.name);
        node = node.parent;
      }
      parts.push(node.mount.opts.root);
      parts.reverse();
      return PATH.join(...parts);
    },
    // This maps the integer permission modes from http://linux.die.net/man/3/open
    // to node.js-specific file open permission strings at http://nodejs.org/api/fs.html#fs_fs_open_path_flags_mode_callback
    flagsForNode(flags) {
      flags &= ~{{{ cDefs.O_PATH }}}; // Ignore this flag from musl, otherwise node.js fails to open the file.
      flags &= ~{{{ cDefs.O_NONBLOCK }}}; // Ignore this flag from musl, otherwise node.js fails to open the file.
      flags &= ~{{{ cDefs.O_LARGEFILE }}}; // Ignore this flag from musl, otherwise node.js fails to open the file.
      flags &= ~{{{ cDefs.O_CLOEXEC }}}; // Some applications may pass it; it makes no sense for a single process.
      flags &= ~{{{ cDefs.O_DIRECTORY }}}; // Node.js doesn't need this passed in, it errors.
      var newFlags = 0;
      for (var k in NODEFS.flagsForNodeMap) {
        if (flags & k) {
          newFlags |= NODEFS.flagsForNodeMap[k];
          flags ^= k;
        }
      }
      if (flags) {
        throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
      }
      return newFlags;
    },
    getattr(func, node) {
      var stat = NODEFS.tryFSOperation(func);
      if (NODEFS.isWindows) {
        // node.js v0.10.20 doesn't report blksize and blocks on Windows. Fake
        // them with default blksize of 4096.
        // See http://support.microsoft.com/kb/140365
        if (!stat.blksize) {
          stat.blksize = 4096;
        }
        if (!stat.blocks) {
          stat.blocks = (stat.size+stat.blksize-1)/stat.blksize|0;
        }
        // Windows does not report the 'x' permission bit, so propagate read
        // bits to execute bits.
        stat.mode |= (stat.mode & {{{ cDefs.S_IRUGO }}}) >> 2;
      }
      return {
        dev: stat.dev,
        ino: node.id,
        mode: stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        rdev: stat.rdev,
        size: stat.size,
        atime: stat.atime,
        mtime: stat.mtime,
        ctime: stat.ctime,
        blksize: stat.blksize,
        blocks: stat.blocks
      };
    },
    // Common code for both node and stream setattr
    // For node getatrr:
    //  - arg is a native path
    //  - chmod, utimes, truncate are fs.chmodSync,  fs.utimesSync,  fs.truncateSync
    // For stream getatrr:
    //  - arg is a native file descriptor
    //  - chmod, utimes, truncate are fs.fchmodSync, fs.futimesSync, fs.ftruncateSync
    setattr(arg, node, attr, chmod, utimes, truncate, stat) {
      NODEFS.tryFSOperation(() => {
        if (attr.mode !== undefined) {
          var mode = attr.mode;
          if (NODEFS.isWindows) {
            // Windows only supports S_IREAD / S_IWRITE (S_IRUSR / S_IWUSR)
            // https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/chmod-wchmod
            mode &= {{{ cDefs.S_IRUSR | cDefs.S_IWUSR }}};
          }
          chmod(arg, mode);
          // update the common node structure mode as well
          node.mode = attr.mode;
        }
        if (typeof (attr.atime ?? attr.mtime) === "number") {
          // Unfortunately, we have to stat the current value if we don't want
          // to change it. On top of that, since the times don't round trip
          // this will only keep the value nearly unchanged not exactly
          // unchanged. See:
          // https://github.com/nodejs/node/issues/56492
          var atime = new Date(attr.atime ?? stat(arg).atime);
          var mtime = new Date(attr.mtime ?? stat(arg).mtime);
          utimes(arg, atime, mtime);
        }
        if (attr.size !== undefined) {
          truncate(arg, attr.size);
        }
      });
    },
    node_ops: {
      getattr(node) {
        var path = NODEFS.realPath(node);
        return NODEFS.getattr(() => fs.lstatSync(path), node);
      },
      setattr(node, attr) {
        var path = NODEFS.realPath(node);
        if (attr.mode != null && attr.dontFollow) {
          throw new FS.ErrnoError({{{ cDefs.ENOSYS }}});
        }
        NODEFS.setattr(path, node, attr, fs.chmodSync, fs.utimesSync, fs.truncateSync, fs.lstatSync);
      },
      lookup(parent, name) {
        var path = PATH.join2(NODEFS.realPath(parent), name);
        var mode = NODEFS.getMode(path);
        return NODEFS.createNode(parent, name, mode);
      },
      mknod(parent, name, mode, dev) {
        var node = NODEFS.createNode(parent, name, mode, dev);
        // create the backing node for this in the fs root as well
        var path = NODEFS.realPath(node);
        NODEFS.tryFSOperation(() => {
          if (FS.isDir(node.mode)) {
            fs.mkdirSync(path, node.mode);
          } else {
            fs.writeFileSync(path, '', { mode: node.mode });
          }
        });
        return node;
      },
      rename(oldNode, newDir, newName) {
        var oldPath = NODEFS.realPath(oldNode);
        var newPath = PATH.join2(NODEFS.realPath(newDir), newName);
        try {
          FS.unlink(newPath);
        } catch(e) {}
        NODEFS.tryFSOperation(() => fs.renameSync(oldPath, newPath));
        oldNode.name = newName;
      },
      unlink(parent, name) {
        var path = PATH.join2(NODEFS.realPath(parent), name);
        NODEFS.tryFSOperation(() => fs.unlinkSync(path));
      },
      rmdir(parent, name) {
        var path = PATH.join2(NODEFS.realPath(parent), name);
        NODEFS.tryFSOperation(() => fs.rmdirSync(path));
      },
      readdir(node) {
        var path = NODEFS.realPath(node);
        return NODEFS.tryFSOperation(() => fs.readdirSync(path));
      },
      symlink(parent, newName, oldPath) {
        var newPath = PATH.join2(NODEFS.realPath(parent), newName);
        NODEFS.tryFSOperation(() => fs.symlinkSync(oldPath, newPath));
      },
      readlink(node) {
        var path = NODEFS.realPath(node);
        return NODEFS.tryFSOperation(() => fs.readlinkSync(path));
      },
      statfs(path) {
        var stats = NODEFS.tryFSOperation(() => fs.statfsSync(path));
        // Node.js doesn't provide frsize (fragment size). Set it to bsize (block size)
        // as they're often the same in many file systems. May not be accurate for all.
        stats.frsize = stats.bsize;
        return stats;
      }
    },
    stream_ops: {
      getattr(stream) {
        return NODEFS.getattr(() => fs.fstatSync(stream.nfd), stream.node);
      },
      setattr(stream, attr) {
        NODEFS.setattr(stream.nfd, stream.node, attr, fs.fchmodSync, fs.futimesSync, fs.ftruncateSync, fs.fstatSync);
      },
      open(stream) {
        var path = NODEFS.realPath(stream.node);
        NODEFS.tryFSOperation(() => {
          stream.shared.refcount = 1;
          stream.nfd = fs.openSync(path, NODEFS.flagsForNode(stream.flags));
        });
      },
      close(stream) {
        NODEFS.tryFSOperation(() => {
          if (stream.nfd && --stream.shared.refcount === 0) {
            fs.closeSync(stream.nfd);
          }
        });
      },
      dup(stream) {
        stream.shared.refcount++;
      },
      read(stream, buffer, offset, length, position) {
        return NODEFS.tryFSOperation(() =>
          fs.readSync(stream.nfd, new Int8Array(buffer.buffer, offset, length), 0, length, position)
        );
      },
      write(stream, buffer, offset, length, position) {
        return NODEFS.tryFSOperation(() =>
          fs.writeSync(stream.nfd, new Int8Array(buffer.buffer, offset, length), 0, length, position)
        );
      },
      llseek(stream, offset, whence) {
        var position = offset;
        if (whence === {{{ cDefs.SEEK_CUR }}}) {
          position += stream.position;
        } else if (whence === {{{ cDefs.SEEK_END }}}) {
          if (FS.isFile(stream.node.mode)) {
            NODEFS.tryFSOperation(() => {
              var stat = fs.fstatSync(stream.nfd);
              position += stat.size;
            });
          }
        }

        if (position < 0) {
          throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        }

        return position;
      },
      mmap(stream, length, position, prot, flags) {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError({{{ cDefs.ENODEV }}});
        }

        var ptr = mmapAlloc(length);

        NODEFS.stream_ops.read(stream, HEAP8, ptr, length, position);
        return { ptr, allocated: true };
      },
      msync(stream, buffer, offset, length, mmapFlags) {
        NODEFS.stream_ops.write(stream, buffer, 0, length, offset, false);
        // should we check if bytesWritten and length are the same?
        return 0;
      }
    }
  }
#endif
});
