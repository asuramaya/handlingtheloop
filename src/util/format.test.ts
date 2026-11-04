import { describe, expect, it } from "vitest";
import { displayArtist } from "./format";

describe("displayArtist", () => {
  it("drops YouTube's auto-generated ' - Topic' channel suffix", () => {
    expect(displayArtist("Britney Spears - Topic")).toBe("Britney Spears");
    expect(displayArtist("food house - topic")).toBe("food house");
    expect(displayArtist("Rihanna -Topic")).toBe("Rihanna");
  });
  it("leaves real names alone, including ones that merely contain the word", () => {
    expect(displayArtist("Imogen Heap")).toBe("Imogen Heap");
    expect(displayArtist("Topic Boys")).toBe("Topic Boys");
    expect(displayArtist("Hot Topic Band")).toBe("Hot Topic Band");
  });
  it("never blanks a name, and tolerates missing values", () => {
    expect(displayArtist("Topic")).toBe("Topic");
    expect(displayArtist("- Topic")).toBe("- Topic");
    expect(displayArtist(undefined)).toBe("");
    expect(displayArtist(null)).toBe("");
  });
});
