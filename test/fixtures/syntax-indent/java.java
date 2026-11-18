// A Java fixture, as google-java-format formats it.
package xyz.yath.edwin;

import java.util.List;
import java.util.Map;

/** A Javadoc comment, its later lines kept. */
@SuppressWarnings("unchecked")
public class Fixture<T extends Comparable<T>> implements Runnable {
  private static final int LIMIT = 10;
  private final List<T> items;

  public Fixture(List<T> items) {
    this.items = items;
  }

  @Override
  public void run() {
    for (T item : items) {
      if (item == null) {
        continue;
      } else if (items.size() > LIMIT) {
        break;
      } else {
        System.out.println(item);
      }
    }
    int i = 0;
    while (i < LIMIT) {
      i++;
    }
    do {
      i--;
    } while (i > 0);
    switch (i) {
      case 0:
        System.out.println("zero");
        break;
      default:
        break;
    }
    String s =
        switch (i) {
          case 1 -> "one";
          default -> {
            yield "other";
          }
        };
    try {
      Thread.sleep(LIMIT);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    } finally {
      i = 0;
    }
    Runnable r =
        () -> {
          System.out.println("ünïcode");
        };
    String text =
        """
        a text block,
          its blanks kept
        """;
    int[] numbers = {1, 2, 3};
    Map<String, Integer> m = Map.of("one", 1, "two", 2);
  }

  enum Color {
    RED,
    GREEN
  }

  interface Shape {
    double area();
  }

  record Pair(int a, int b) {}
}

class Long {
  void call() {
    String result =
        someObject.someMethodWithAVeryLongName(firstArgument, secondArgument, thirdArgument);
    List<String> names =
        items.stream().filter(x -> x != null).map(Object::toString).collect(Collectors.toList());
    boolean ok =
        firstCondition && secondCondition || thirdConditionWithAVeryLongNameIndeed && fourth;
    if (firstCondition && secondConditionWithALongName && thirdConditionWithAnEvenLongerName) {
      run();
    }
  }

  public static <T> void longSignature(
      String firstParameter, int secondParameter, List<T> thirdParameter) {}
}

class Longer {
  void call() {
    String result =
        someObject.someMethodWithAVeryLongName(
            firstArgument, secondArgument, thirdArgument, fourthArgument, fifthArgument);
    List<String> names =
        items.stream()
            .filter(x -> x != null)
            .map(Object::toString)
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .collect(Collectors.toList());
    if (firstCondition
        && secondConditionWithALongName
        && thirdConditionWithAnEvenLongerName
        && fourthCondition) {
      run();
    }
    log(
        "a message that is long enough",
        someObject.someMethodWithAVeryLongName(firstArgument, secondArgument));
  }
}

/**
 * A Javadoc comment long enough that google-java-format keeps it over lines, its later lines kept
 * as they are by the rules.
 *
 * @param <T> the type
 */
abstract class More<T> {
  @Deprecated(since = "1.0", forRemoval = true)
  abstract T get() throws java.io.IOException;

  void anonymous() {
    Runnable r =
        new Runnable() {
          @Override
          public void run() {
            if (ready) return;
            if (other)
              System.out.println(
                  "a braceless body that is long enough to go on a line of its own here");
            else done();
            for (int i = 0; i < 10; i++)
              System.out.println("another braceless body that is long enough for its own line too");
          }
        };
    CompletableFuture.supplyAsync(() -> compute())
        .thenApply(x -> x * 2)
        .thenAccept(System.out::println)
        .join();
    items.forEach(
        item -> {
          process(item);
        });
    int value =
        condition
            ? someVeryLongMethodName(argumentNumberOne)
            : anotherVeryLongMethodName(argumentNumberTwo);
  }

  @Inject
  @Named("cache")
  private final Map<String, Integer> cache = null;

  @Override
  public static <U> void forward(
      U aaaaaaaaaaaaaaaaaaaaaaaaaaaa,
      U bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
      U cccccccccccccccccccccc,
      U d)
      throws Exception, java.io.IOException {
    @SuppressWarnings("unchecked")
    final List<U> all = (List<U>) List.of(aaaaaaaaaaaaaaaaaaaaaaaaaaaa, d);
  }

  More(int aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
      throws Exception {
    this.value = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;
  }

  enum Planet {
    MERCURY(3.303e+23, 2.4397e6),
    EARTH(5.976e+24, 6.37814e6);

    private final double mass;

    Planet(double mass, double radius) {
      this.mass = mass;
    }
  }
}
