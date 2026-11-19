import type { Game } from "./catalog.ts";

type PinnedAsset = readonly [sourcePath: string, galleryPath: string, sha256: string, bytes: number];
type PinnedDetail = readonly [sourcePath: string, sha256: string, bytes: number];

interface LegacyAtlasRecordSource {
  readonly game: Game;
  readonly pageId: string;
  readonly recordId: string;
  readonly detail: PinnedDetail;
  readonly artwork: readonly PinnedAsset[];
}

// Paths, sizes and SHA-256 digests were compared against direct public response captures.
export const legacyAtlasRecordSources = {
  "gi/weapon/11401": { game: "gi", pageId: "weapon", recordId: "11401",
    detail: ["/gi/7.2.52/zh/weapon/11401.json", "01a3cdcdaafb60f7f56baac04a9234b8199177b544a47fcbe2beb32d417a481a", 11389],
    artwork: [
      ["/assets/gi/UI_EquipIcon_Sword_Zephyrus.webp", "gallery/gi/UI_EquipIcon_Sword_Zephyrus.webp",
        "49961cad340d708e72fe646c87b587bb64895c28faa791941389b5d4952e39ee", 13816],
    ],
  },
  "hsr/lightcone/21000": { game: "hsr", pageId: "lightcone", recordId: "21000",
    detail: ["/hsr/4.7.52/zh/lightcone/21000.json", "411c488103998cab7e59bfacf83244f6a2eb7afd38aa2da29ce827c2ad53e37b", 4842],
    artwork: [
      ["/assets/hsr/lightconemediumicon/21000.webp", "gallery/hsr/lightconemediumicon/21000.webp",
        "2a0e83b90f4e1a9cdea2385e53a80009ab10dd5e1f8d90e742de5c43c33dc4a1", 59616],
      ["/assets/hsr/pathicon/priest.webp", "gallery/hsr/pathicon/priest.webp",
        "072f45e1925a458a26248d47f9f001abf66277df16ad2d90590febb6e388bbf0", 36222],
    ],
  },
  "hsr/maze_boss/3022": { game: "hsr", pageId: "maze_boss", recordId: "3022",
    detail: ["/hsr/4.7.52/zh/boss/3022.json", "c993292158ddaf0c9b4db3716a88783460de7ced5f1de09069e5f39619fa04aa", 64991],
    artwork: [],
  },
  "zzz/shiyu/62061": { game: "zzz", pageId: "shiyu", recordId: "62061",
    detail: ["/zzz/3.4.4+20539349/zh/shiyu/62061.json", "3fc246f64b88fa779fef8a73d55b0d447b6e1614f72df42dfc0423cebd418e9f", 38984],
    artwork: [
      ["/assets/zzz/Monster_Arbiter.webp", "gallery/zzz/Monster_Arbiter.webp",
        "316a2f64fb2508f533086db77f40dd83213aaf42349bb72361df76a1d019c6f2", 113728],
      ["/assets/zzz/Monster_BangbooBattleMecha.webp", "gallery/zzz/Monster_BangbooBattleMecha.webp",
        "84f6e7ea3d639add1ba97a577f37587ca590fcb3cea7ee7c785a07769ecb93b0", 103886],
      ["/assets/zzz/Monster_BangbooPatrolMecha.webp", "gallery/zzz/Monster_BangbooPatrolMecha.webp",
        "e7d90864e0189093b7b028b793f7901086e085f35a93629ede30b230d320bc11", 82114],
      ["/assets/zzz/Monster_CorruptedBattleMecha.webp", "gallery/zzz/Monster_CorruptedBattleMecha.webp",
        "e2ba86bd65f821f57aebbf448873b17966f8f9c1a7f122594514a93aee0dfb57", 105718],
      ["/assets/zzz/Monster_CorruptedPatrolMecha.webp", "gallery/zzz/Monster_CorruptedPatrolMecha.webp",
        "fbbeacc41b641a5b6282ee76e06dc3c3dbae877a46ab5bff6d148b97b1c2d37a", 82030],
      ["/assets/zzz/Monster_EyeEngine.webp", "gallery/zzz/Monster_EyeEngine.webp",
        "69777590381bbf41ac83794746ebaeb1a8641b87cbd71d4ff87e54086c333f95", 91408],
      ["/assets/zzz/Monster_FrenziedManiacPro.webp", "gallery/zzz/Monster_FrenziedManiacPro.webp",
        "ab329598b41c442f5c5a7677694d4c368ef5aeec43afefb915987b36a57f2156", 111436],
      ["/assets/zzz/Monster_Greatsworder.webp", "gallery/zzz/Monster_Greatsworder.webp",
        "2c3f19c8eb5572f1da3777c79a248bc21bc997a8e96242c44662ea1572e63db7", 89898],
      ["/assets/zzz/Monster_GreedyRangerPro.webp", "gallery/zzz/Monster_GreedyRangerPro.webp",
        "0205744c588041f79f05a724bf2865bed7d98d57d6c5ad36726b9ae3067ad2eb", 141882],
      ["/assets/zzz/Monster_Halberdier.webp", "gallery/zzz/Monster_Halberdier.webp",
        "e9d268e27e89083d0a2253f7878bd5f252f1ba1b61d27ef10e33d1e5cbff6606", 70230],
      ["/assets/zzz/Monster_Hayyot.webp", "gallery/zzz/Monster_Hayyot.webp",
        "b2ad7f3f1f34d72bb000e6aac964b61c55ae0851afcf27c3d04fe32f385555c1", 108982],
      ["/assets/zzz/Monster_MiasmaFrenziedManiac.webp", "gallery/zzz/Monster_MiasmaFrenziedManiac.webp",
        "c113934229bcf62c9339a30beb32eddfd5b615b9616260e396f1b879649ad951", 126860],
      ["/assets/zzz/Monster_MiasmaIsoldeSlime.webp", "gallery/zzz/Monster_MiasmaIsoldeSlime.webp",
        "192a8981f52f56538a795afdc63122e57eab53be9052fd089255a947d365064c", 64808],
      ["/assets/zzz/Monster_MiasmaTerrorBird.webp", "gallery/zzz/Monster_MiasmaTerrorBird.webp",
        "e4c3574c94ba86327e4e275e73c962484ea77da18a71a0f20b653dfe5728e7ab", 103526],
      ["/assets/zzz/Monster_MiasmaTrinox.webp", "gallery/zzz/Monster_MiasmaTrinox.webp",
        "215a56398672cd78deeb416ec833f4f905984e4f469a1a9d97b74015c2f40353", 113876],
      ["/assets/zzz/Monster_MiasmaWickedWraith.webp", "gallery/zzz/Monster_MiasmaWickedWraith.webp",
        "8b7bc6a2df82ae147f217d78401c35f09dbe9f27dee115bb6a1f7a95f9a84ac7", 124444],
      ["/assets/zzz/Monster_Minion.webp", "gallery/zzz/Monster_Minion.webp",
        "6a0fb6543f6477e20cd64718a07bf00c616d76284b94ec567c9d8b9b7d722c19", 90510],
      ["/assets/zzz/Monster_MoltTarasqueMixer.webp", "gallery/zzz/Monster_MoltTarasqueMixer.webp",
        "f3c9abbbdbad4de7f5d0b5b0ce18dbf7a0c40fa4f138d5229936ce363bff716b", 88698],
      ["/assets/zzz/Monster_Predator.webp", "gallery/zzz/Monster_Predator.webp",
        "57674850b3c82bbdd48cda88fca2c1b77cecc717667133ffcc973bf2ca6ce928", 103716],
      ["/assets/zzz/Monster_RoscaSolider.webp", "gallery/zzz/Monster_RoscaSolider.webp",
        "e2642697e27c0bbe0621f73751cce3623747dd21b423b2858456445b93dd6de4", 100006],
      ["/assets/zzz/Monster_RuthlessFiendPro.webp", "gallery/zzz/Monster_RuthlessFiendPro.webp",
        "934bb19d21145996788714f6dc68d2a3d2c025777ba50398f507aa8649548768", 100756],
      ["/assets/zzz/Monster_Sentinel.webp", "gallery/zzz/Monster_Sentinel.webp",
        "a1cd11f47e88c9036fb0c56e1b06a27115dc6e90ee66de5d56f3abb62acb4f01", 120096],
      ["/assets/zzz/Monster_ThugBulkyEnforcerPro.webp", "gallery/zzz/Monster_ThugBulkyEnforcerPro.webp",
        "e2b33ef49e5434e0cfbc0be6d4ac0afb030efc54abca0f35766b0403bc4e3bb5", 93866],
      ["/assets/zzz/Monster_ThugPyromaniacPro.webp", "gallery/zzz/Monster_ThugPyromaniacPro.webp",
        "dee48f4d2034c3db62acba01c42bae7e5ec695d41e0f96a7918908f2d2ec6cb3", 107300],
      ["/assets/zzz/Monster_ThugRaiderPro.webp", "gallery/zzz/Monster_ThugRaiderPro.webp",
        "2ab73327d61af8c1aac9e211749d815fe348c6c965dbe827cb66b7da1274ee65", 111654],
      ["/assets/zzz/Monster_ViciousStrikerPro.webp", "gallery/zzz/Monster_ViciousStrikerPro.webp",
        "79cc4900f184c2001fdaf31f68648faead5e4f579e3bdf692ad03a8a672ccaaf", 98044],
      ["/assets/zzz/Monster_WickedWraithPro.webp", "gallery/zzz/Monster_WickedWraithPro.webp",
        "e83955cf8f23c3ff3520b25d5f03d544f2132d43a1c377ab9bec01d4c5322dfc", 90298],
      ["/assets/zzz/Monster_WingedChelonethid.webp", "gallery/zzz/Monster_WingedChelonethid.webp",
        "4514fcadef9cb40a538daff611ce9ec67eae8dbf747b79430126a1b510c78aad", 103236],
    ],
  },
} as const satisfies Readonly<Record<string, LegacyAtlasRecordSource>>;

export type LegacyAtlasRecordKey = keyof typeof legacyAtlasRecordSources;
