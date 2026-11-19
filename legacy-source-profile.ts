import type { Game } from "./catalog.ts";
import type { AtlasCandidatePage } from "./validate-candidate.ts";

// These are the audited legacy indexes, distinct from the current formal releases.
const profiles = {
  gi: { version: "7.2.52", pages: [
    ["character", 154, "object", "b14bef66f6a79374d617ac9434d130e2338cbcc96753993a0ee653dc59c595c7"],
    ["artifact", 67, "object", "f46938d9f1597b87076a99622cd60e7174591655fd6aadf05b6951655d56b2a7"],
    ["monster", 593, "object", "f1fa751290a1bfbc140afa6ec85439fa63ef0e773dee8af582cfe599cb51c4fe"],
    ["weapon", 292, "object", "d08260d377616ee33af3dcf4d0d47cfb4f20244381add78b69375aa9adf1f094"],
    ["achievement/achievement", 75, "object", "599048cdb44136e354b8c0e900d1a0a9cdb5d2feed240ca105fab557524ccf87"],
    ["leyline", 14, "object", "14636377bde7c06d7d2a08875e6f45c7eb8a0ce18f17169f962d9ddf88410576"],
    ["rolecombat", 31, "object", "ea42e5e7d75e6c02b9910e0485e0203ff74c7d4d351ffa1f94a6bf66fcc99345"],
    ["tower", 30, "object", "59058a4ead65452a557c806022a2f48b6591aeaa37916241dd21e04ab0514808"],
  ] },
  hsr: { version: "4.7.52", pages: [
    ["lightcone", 174, "object", "219d81912bcf84346641c5b0b0cb814395087245e338a44afc61338b3d8dbaf5"],
    ["character", 101, "object", "71943d5e1ffee6249db81afb998652795cdfc6da0aa4cd3295ff1c6e2d13cc03"],
    ["monster", 666, "object", "7b321a5fd14627f779a0d9ea0603721fdf049fcc49e482008462ffdf8ac8d862"],
    ["relicset", 64, "object", "3addc93e5d779671b27d6f78468d04bc127cfd793b096ff2aaac2feada405f94"],
    ["achievement/achievement", 9, "object", "534462744f4093167ebae3caa8f7af74ddbfc387efbfacd9318a982003f2f2f7"],
    ["maze_boss", 24, "object", "5d6ff2ad355ce041bc07cbd2c37c105d0b0a0656a88957ecf02cbddfcc0829ff"],
    ["maze", 49, "object", "fa5ad1566549319bcf51abf9c7e69acd514452baf5899afadafe7287fcd55af9"],
    ["maze_peak", 12, "object", "02fa7735008d94e3d1208113f29213ed833a0e97f19f761e52af59f69bd4b9c0"],
    ["maze_extra", 29, "object", "07e8a2bbca1d951e73fc933c520d13d7e81a7e78f7c2bcb1e615e5e53843e3ba"],
    ["monstervalue", 666, "object", "fcbbea2ca2e51ebeedf3cdf9cad997267f836f366ec248db4976890ceb1a3dc4"],
    ["EliteGroup", 1461, "array", "43ae8f5f99fcec4cb519abdda1394da3979eae22bcdd7a0d83cfe17d6178b78f"],
    ["HardLevelGroup", 787, "array", "81b6912b9d510460c6ccb52a04c0ae635e63d5cc3072414a2ec7f6d9e0fdfcec"],
    ["InfiniteEliteGroup", 65, "array", "16728e9b826d583af11f37022e284e84270bef9ebd8b2d6e6e0e8b8f613ad946"],
  ] },
  zzz: { version: "3.4.4+20539349", pages: [
    ["weapon", 106, "object", "3f49f60cedbf51d5d4a409a3073b09e6d607014a2615f8a89c2319c04ec62293"],
    ["character", 65, "object", "ed4c5ed34b35b9b4b9ee379d2dd28b9f294bbb59b22fd316a2185624a5f73df7"],
    ["bangboo", 44, "object", "8f324770c2a66eed79a739bfda24867322bba41c7def1a6c5d69b5a798740226"],
    ["equipment", 32, "object", "e61a08025b590a1afa756331625d75e1e4e615e30d406e392f31909c2f571cdb"],
    ["monster", 321, "object", "c4e62d000eea323695554d04c410534417b24979afad38e1d9e719cafece7d59"],
    ["achievement/achievement", 3, "object", "9f7c7fc7d342c200d3a9af2e58c692623c62117b831c4301b9288e8ddbd20817"],
    ["boss", 53, "object", "a4c1d87f73a2536705f267935851117d6238b15a2bb5b4901a522d73ce57a750"],
    ["shiyu", 68, "object", "e1002643f7208644e825eefff21ba80725978af5cd5ed83ee77088b2ead4f67e"],
  ] },
} as const;

export interface LegacyAtlasSourcePage extends Required<AtlasCandidatePage> {
  readonly indexPath: string;
  readonly indexShape: "object" | "array";
  readonly indexSha256: string;
}

export const legacyAtlasSourcePages: readonly LegacyAtlasSourcePage[] = (Object.keys(profiles) as Game[]).flatMap((game) => {
  const { version, pages } = profiles[game];
  return pages.map(([pageId, recordCount, indexShape, indexSha256]) => ({
    game, version, pageId, recordCount, indexShape, indexSha256,
    indexPath: `/${game}/${version}/${pageId === "achievement/achievement" ? "zh/" : ""}${pageId}.json`,
  }));
});

export const legacyAtlasCounts = { detailCount: 2989, imageCount: 6222 } as const;
