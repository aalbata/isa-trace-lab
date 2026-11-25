# More scalar variables than any target has home registers.
def main(a, b):
    v1 = a + 1
    v2 = b + 2
    v3 = v1 + v2
    v4 = v3 - a
    v5 = v4 * 3
    v6 = v5 ^ v1
    v7 = v6 | 5
    v8 = v7 & 255
    v9 = v8 + v2
    v10 = v9 - v3
    v11 = v10 * v4
    v12 = v11 + v5
    v13 = v12 - v6
    v14 = v13 ^ v7
    v15 = v14 + v8
    v16 = v15 - v9
    v17 = v16 + v10
    v18 = v17 ^ v11
    for i in range(3):
        v18 += v1 * i
        v17 -= v18
    print(v15)
    print(v16)
    print(v17)
    print(v18)
    return v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9 + v10 + v11 + v12 + v13 + v14 + v15 + v16 + v17 + v18
