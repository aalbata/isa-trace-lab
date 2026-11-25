# Index of the first element equal to the key, or -1.
def main(key):
    data = [4, 8, 15, 16, 23, 42]
    found = -1
    for i in range(len(data)):
        if data[i] == key:
            found = i
            break
    print(found)
    return found
