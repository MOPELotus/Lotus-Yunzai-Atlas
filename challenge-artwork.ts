export const prismSlimeArtwork = {
  path: "gallery/gi/hoyowiki/11052.png",
  sha256: "694fab4aad6a86dd57bf8cf68488ea7e2d7c9942009d23934128701c7de64fcc",
};

export const churinArtwork = {
  path: "gallery/gi/UI_MonsterIcon_Karzelek_Tsereteli_01.png",
  sha256: "74ae70bfdd1630f3134d559a5b53d94a28e6c2d45b183f8ddb81bbff896c30af",
};

export const samachurlArtwork = {
  path: "gallery/gi/verified/Churldric.png",
  sha256: "6d246e440e6f3e3890760a329a1703fca7e382189de2757bb95e04a585edc161",
};

export const challengeArtworkDigests: ReadonlyMap<string, string> = new Map(
  [prismSlimeArtwork, churinArtwork, samachurlArtwork].map(({ path, sha256 }) => [path, sha256]),
);
