# pass statements, constant conditions, and a loop left only by break.
def main(n):
    pass
    if True:
        n += 1
    if False:
        n += 100
    else:
        pass
    while True:
        n += 3
        if n > 20:
            break
        pass
    while False:
        n = 0
    for i in range(0):
        n = -1
    pass
    return n
