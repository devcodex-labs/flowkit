#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/' || getuid() == 0 || getuid() != geteuid()
      || getgid() != getegid() || prctl(PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L) != 1) {
    fputs("Expected an absolute executable under the restricted Model account\n", stderr);
    return 2;
  }
  if (close_range(3, ~0U, 0) == -1) {
    perror("Close extra descriptors");
    return 1;
  }
  for (int fd = 0; fd <= 2; fd++) {
    int flags = fcntl(fd, F_GETFL);
    if (flags == -1 || fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) == -1) {
      perror("Restore blocking stdio");
      return 1;
    }
  }
  execv(argv[1], &argv[1]);
  perror("Start Model executable");
  return 1;
}
