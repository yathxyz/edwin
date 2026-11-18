/* A fixture for the indent engine: clang-format's layout with IndentWidth 4. */
#include <stdio.h>
#include <stdlib.h>

struct point {
    int x;
    int y;
};

enum colour {
    RED,
    GREEN,
    BLUE,
};

/*
 * A block comment
 *   over lines, kept as written.
 */
static int classify(int n) {
    switch (n) {
    case 0:
        return 0;
    case 1:
    case 2: {
        int doubled = n * 2;
        return doubled;
    }
    default:
        break;
    }
    if (n > 10) {
        return 1;
    } else if (n < -10) {
        return -1;
    } else {
        return 2;
    }
}

static long sum_points(const struct point *points, size_t count,
                       long offset_value_that_is_long, int scale_factor) {
    long total = offset_value_that_is_long;
    for (size_t i = 0; i < count; i++) {
        total +=
            (long)points[i].x * scale_factor + (long)points[i].y * scale_factor;
    }
    while (total > 1000)
        total /= 2;
    return total;
}

int main(void) {
    struct point points[] = {
        {1, 2},
        {3, 4},
    };
    const char *text = "a string with a brace { in it";
    int values[3] = {0, 1, 2};
    long total = sum_points(points, sizeof points / sizeof points[0], 10,
                            classify(values[1]));
    do {
        total--;
    } while (total > 0);
    printf("%s %ld\n", text, total);
    return EXIT_SUCCESS;
}

int nested(int a, int b, int c) {
    if (a) {
        if (b && (c || a > b) && (a < 100 || b < 100) && (c != a + b) &&
            some_function_name(a, b)) {
            return 1;
        }
    }
    for (int index = 0;
         index < a && index < b && index < c + some_function_name(a, b);
         index++) {
        c += index;
    }
    if (a > b) {
        c = 1;
    }
    // a comment before the else
    else {
        c = 2;
    }
#ifdef DEBUG
    c = 3;
#endif
    return a && b && some_function_name(a, b) && some_function_name(b, c) &&
           some_function_name(c, a);
}
