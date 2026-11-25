# Leaving main without a value reports 0.
def main(n):
    if n > 0:
        print(n)
        return
    if n == 0:
        return 42
    print(-n)
