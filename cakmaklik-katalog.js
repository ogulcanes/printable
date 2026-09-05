/* Toptan çakmaklık kataloğu.

   Liste MakerWorld'deki "lighter" koleksiyonundan derlendi; her kayıt bir
   modelin kimliği, Türkçe adı, rozeti, kısa notu, önizleme görseli ve model
   bağlantısıdır. Aynı liste sunucuda da kullanılır (server.js require eder):
   toplu talep uç noktası ürün adını istemciden değil buradan alır, böylece
   panele düşen kayıt ve e-posta her zaman gerçek modelleri gösterir.

   Kart/seçim davranışı katalog-secim.js'te; bu dosya yalnızca veriyi ve
   sayfaya özel yapılandırmayı tutar. */

const LIGHTER_PRODUCTS = [
  { id: "2977505", name: "Moai Heykeli", tag: "Bic Kılıfı", note: "Paskalya Adası moai yüzü kabartmalı Bic kılıfı", img: "/assets/cakmaklik-katalog/2977505.webp", url: "https://makerworld.com/tr/models/2977505-moai-statue-bic-sleeve-easter-island" },
  { id: "3173643", name: "Korsan Maymun", tag: "Bic Kılıfı", note: "Göz bantlı korsan maymun figürlü Bic kılıfı", img: "/assets/cakmaklik-katalog/3173643.webp", url: "https://makerworld.com/tr/models/3173643-pirate-ape-bic-sleeve" },
  { id: "3173652", name: "Smokinli Kedi", tag: "Bic Kılıfı", note: "Siyah beyaz smokinli kedi figürlü Bic kılıfı", img: "/assets/cakmaklik-katalog/3173652.webp", url: "https://makerworld.com/tr/models/3173652-tuxedo-cat-bic-sleeve" },
  { id: "616045", name: "Batman", tag: "Bic Kılıfı", note: "Batman temalı Bic kılıfı, ikinci sürüm", img: "/assets/cakmaklik-katalog/616045.webp", url: "https://makerworld.com/tr/models/616045-batman-bic-sleeve-v2" },
  { id: "1479738", name: "Dolar Deseni", tag: "Bic Kılıfı", note: "Dolar işlemeli Bic kılıfı, küçük ve büyük boy", img: "/assets/cakmaklik-katalog/1479738.webp", url: "https://makerworld.com/tr/models/1479738-money-bic-lighter-sleeve-small-and-large" },
  { id: "1178151", name: "GTA Wanted", tag: "Bic Kılıfı", note: "GTA aranıyor yıldızları temalı Bic kılıfı", img: "/assets/cakmaklik-katalog/1178151.webp", url: "https://makerworld.com/tr/models/1178151-gta-wanted-bic-sleeve" },
  { id: "248210", name: "Kuru Kafa", tag: "Bic Kılıfı", note: "İnsan kafatası biçimli Bic kılıfı", img: "/assets/cakmaklik-katalog/248210.webp", url: "https://makerworld.com/tr/models/248210-bic-human-skull-sleeve" },
  { id: "1599919", name: "Sünger Bob", tag: "Bic Kılıfı", note: "Sünger dokulu, uykulu bakışlı sarı Bic kılıfı", img: "/assets/cakmaklik-katalog/1599919.webp", url: "https://makerworld.com/tr/models/1599919-chill-spongebob-squarepants-bic-lighter-sleeve" },
  { id: "2629812", name: "Nokia 3310", tag: "Bic Kılıfı", note: "Efsane telefon biçiminde Bic kılıfı", img: "/assets/cakmaklik-katalog/2629812.webp", url: "https://makerworld.com/tr/models/2629812-nokia-3310-bic-lighter-case" },
  { id: "2338561", name: "Ejderha", tag: "Bic Kılıfı", note: "Gövdeye dolanan ejderha kabartmalı Bic kılıfı", img: "/assets/cakmaklik-katalog/2338561.webp", url: "https://makerworld.com/tr/models/2338561-dragon-bic-sleeve" },
  { id: "1324410", name: "Ejderha Pulu Dokusu", tag: "Bic Kılıfı", note: "Pul dokulu, kavraması kolay Bic kılıfı", img: "/assets/cakmaklik-katalog/1324410.webp", url: "https://makerworld.com/tr/models/1324410-bic-lighter-sleeve-dragon-scale" },
  { id: "1214014", name: "Tırtıklı EDC", tag: "Bic Kılıfı", note: "Tırtıklı yüzeyli, kaymayan sade Bic kılıfı", img: "/assets/cakmaklik-katalog/1214014.webp", url: "https://makerworld.com/tr/models/1214014-totally-knurly-bic-classic-lighter-sleeves-edc" },
  { id: "1573887", name: "Monogram Desen", tag: "Bic Kılıfı", note: "Kabartma monogram desenli Bic kılıfı", img: "/assets/cakmaklik-katalog/1573887.webp", url: "https://makerworld.com/tr/models/1573887-lv-bic-sleeve-v4" },
  { id: "2923331", name: "Ghostface — Kabartma", tag: "Bic Kılıfı", note: "Üç boyutlu Ghostface maskeli Bic kılıfı", img: "/assets/cakmaklik-katalog/2923331.webp", url: "https://makerworld.com/tr/models/2923331-scream-ghostface-bic-sleeve" },
  { id: "1788989", name: "Ghostface — Renkli", tag: "Bic Kılıfı", note: "Renkli gövdede düz Ghostface yüzü", img: "/assets/cakmaklik-katalog/1788989.webp", url: "https://makerworld.com/tr/models/1788989-scream-bic-sleeve-3-ams" },
  { id: "1718471", name: "Punisher Kuru Kafası", tag: "Bic Kılıfı", note: "Punisher kafatası logolu Bic kılıfı", img: "/assets/cakmaklik-katalog/1718471.webp", url: "https://makerworld.com/tr/models/1718471-punisher-skull-bic-sleeve-3-for-ams" },
  { id: "1303987", name: "Uzaylı", tag: "Bic Kılıfı", note: "Uzaylı yüzü kabartmalı Bic kılıfı", img: "/assets/cakmaklik-katalog/1303987.webp", url: "https://makerworld.com/tr/models/1303987-alien-bic-sleeve" },
  { id: "1275424", name: "Angry Birds", tag: "Bic Kılıfı", note: "Kızgın kuş figürlü kırmızı Bic kılıfı", img: "/assets/cakmaklik-katalog/1275424.webp", url: "https://makerworld.com/tr/models/1275424-angry-birds-bic-sleeve" },
  { id: "1328262", name: "Homer Scarface", tag: "Bic Kılıfı", note: "Scarface afişi pozunda Homer figürlü Bic kılıfı", img: "/assets/cakmaklik-katalog/1328262.webp", url: "https://makerworld.com/tr/models/1328262-homer-scarface-bic-sleeve" },
  { id: "1210256", name: "Bart", tag: "Bic Kılıfı", note: "Kutu logonun arkasından bakan Bart figürlü Bic kılıfı", img: "/assets/cakmaklik-katalog/1210256.webp", url: "https://makerworld.com/tr/models/1210256-supreme-bart-bic-sleeve-2" },
  { id: "1759801", name: "Rick", tag: "Bic Kılıfı", note: "Rick temalı mavi Bic kılıfı", img: "/assets/cakmaklik-katalog/1759801.webp", url: "https://makerworld.com/tr/models/1759801-bic-rick-lighter-sleeve" },
  { id: "1214043", name: "Joker — Telefon Standlı", tag: "Bic Kılıfı", note: "Telefon standına dönüşen Joker temalı Bic kılıfı", img: "/assets/cakmaklik-katalog/1214043.webp", url: "https://makerworld.com/tr/models/1214043-the-joker-bic-sleeve-phone-stand" },
  { id: "1218750", name: "Meraklı Homer — Telefon Standlı", tag: "Bic Kılıfı", note: "Telefon standına dönüşen Homer temalı Bic kılıfı", img: "/assets/cakmaklik-katalog/1218750.webp", url: "https://makerworld.com/tr/models/1218750-curious-homer-bic-sleeve-phone-stand" },
  { id: "1933467", name: "Deadpool", tag: "Çakmak Kılıfı", note: "Deadpool maskeli çakmak kılıfı", img: "/assets/cakmaklik-katalog/1933467.webp", url: "https://makerworld.com/tr/models/1933467-deadpool-lighter-case" },
  { id: "1173685", name: "Eriyen Kuru Kafa", tag: "Çakmak Kılıfı", note: "Erimiş görünümlü, çok renkli kafatası çakmak kılıfı", img: "/assets/cakmaklik-katalog/1173685.webp", url: "https://makerworld.com/tr/models/1173685-melting-skull-lighter-case" },
  { id: "3142261", name: "Sonic", tag: "Clipper Kılıfı", note: "Sonic the Hedgehog figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3142261.webp", url: "https://makerworld.com/tr/models/3142261-sonic-hedgehog-clipper-cover" },
  { id: "3011630", name: "Baby Yoda", tag: "Clipper Kılıfı", note: "Grogu figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3011630.webp", url: "https://makerworld.com/tr/models/3011630-baby-yoda-clipper-cover" },
  { id: "3107382", name: "Pikachu", tag: "Clipper Kılıfı", note: "Pokémon Pikachu figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3107382.webp", url: "https://makerworld.com/tr/models/3107382-pokemon-pikachu-clipper-cover" },
  { id: "2907634", name: "Monster Pençesi", tag: "Clipper Kılıfı", note: "Monster pençe logolu, mat siyah Clipper kılıfı", img: "/assets/cakmaklik-katalog/2907634.webp", url: "https://makerworld.com/tr/models/2907634-monster-claw-clipper-cover" },
  { id: "3156804", name: "Mickey Mouse", tag: "Clipper Kılıfı", note: "Mickey Mouse figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3156804.webp", url: "https://makerworld.com/tr/models/3156804-mickey-mouse-clipper-cover" },
  { id: "3042723", name: "Bebek Charmander", tag: "Clipper Kılıfı", note: "Pokémon Charmander figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3042723.webp", url: "https://makerworld.com/tr/models/3042723-charmander-baby-clipper-cover" },
  { id: "3063293", name: "Bebek Winnie", tag: "Clipper Kılıfı", note: "Winnie the Pooh figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3063293.webp", url: "https://makerworld.com/tr/models/3063293-baby-pooh-clipper-cover" },
  { id: "3102738", name: "Hulk", tag: "Clipper Kılıfı", note: "Marvel Hulk figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3102738.webp", url: "https://makerworld.com/tr/models/3102738-marvel-hulk-clipper-cover" },
  { id: "3011926", name: "Ejderha Ruhu", tag: "Clipper Kılıfı", note: "Gövdeye dolanan ejderha kabartmalı Clipper kılıfı", img: "/assets/cakmaklik-katalog/3011926.webp", url: "https://makerworld.com/tr/models/3011926-dragon-spirit-clipper-cover" },
  { id: "860510", name: "El Bombası", tag: "Clipper Kılıfı", note: "El bombası biçimli Clipper kılıfı", img: "/assets/cakmaklik-katalog/860510.webp", url: "https://makerworld.com/tr/models/860510-clipper-lighter-grenade-case" },
  { id: "2985990", name: "Garfield", tag: "Clipper Kılıfı", note: "Garfield figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/2985990.webp", url: "https://makerworld.com/tr/models/2985990-clipper-garfield" },
  { id: "2901177", name: "Sokak Garfield", tag: "Clipper Kılıfı", note: "Kapüşonlu sokak stili Garfield Clipper kılıfı", img: "/assets/cakmaklik-katalog/2901177.webp", url: "https://makerworld.com/tr/models/2901177-urban-garfield-clipper-lighter-case" },
  { id: "3094269", name: "Çirkin Ördek Yavrusu", tag: "Clipper Kılıfı", note: "Sevimli ördek yavrusu figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3094269.webp", url: "https://makerworld.com/tr/models/3094269-ugly-duckling-clipper-cover" },
  { id: "2988676", name: "Gumball", tag: "Clipper Kılıfı", note: "Gumball Watterson figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/2988676.webp", url: "https://makerworld.com/tr/models/2988676-gumball-clipper-cover" },
  { id: "2988732", name: "Richard Watterson", tag: "Clipper Kılıfı", note: "Gumball dizisinden Richard figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/2988732.webp", url: "https://makerworld.com/tr/models/2988732-richard-watterson-clipper-cover" },
  { id: "2990187", name: "Darwin", tag: "Clipper Kılıfı", note: "Gumball dizisinden Darwin figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/2990187.webp", url: "https://makerworld.com/tr/models/2990187-darwin-clipper-cover" },
  { id: "3016500", name: "Şirin Baba", tag: "Clipper Kılıfı", note: "Şirinler'den Şirin Baba figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3016500.webp", url: "https://makerworld.com/tr/models/3016500-grand-smurf-clipper-cover" },
  { id: "387465", name: "İşlemeli Kuru Kafa", tag: "Clipper Kılıfı", note: "Süslemeli kafatası kabartmalı Clipper kılıfı", img: "/assets/cakmaklik-katalog/387465.webp", url: "https://makerworld.com/tr/models/387465-ornate-skull-clipper-case" },
  { id: "2986234", name: "Hello Kitty", tag: "Clipper Kılıfı", note: "Hello Kitty figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/2986234.webp", url: "https://makerworld.com/tr/models/2986234-hello-kitty-clipper-cover" },
  { id: "3028173", name: "Fred Çakmaktaş", tag: "Clipper Kılıfı", note: "Taş Devri'nden Fred figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3028173.webp", url: "https://makerworld.com/tr/models/3028173-fred-flinstone-clipper-lighter-case" },
  { id: "3010965", name: "Doraemon", tag: "Clipper Kılıfı", note: "Doraemon figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3010965.webp", url: "https://makerworld.com/tr/models/3010965-doraemon-clipper-case" },
  { id: "3041567", name: "Scream", tag: "Clipper Kılıfı", note: "Scream maskesi figürlü Clipper kılıfı", img: "/assets/cakmaklik-katalog/3041567.webp", url: "https://makerworld.com/tr/models/3041567-scream-clipper-cover" },
  { id: "388826", name: "Darth Vader", tag: "Clipper Kılıfı", note: "Darth Vader kaskı biçiminde Clipper kılıfı", img: "/assets/cakmaklik-katalog/388826.webp", url: "https://makerworld.com/tr/models/388826-darth-vader-head-clipper-case" },
  // Kılıf değil: sigarayı ve çakmağı birlikte taşıyan tabaka. Rozeti bilerek
  // ayrı, müşteri kılıf sanıp sipariş vermesin.
  { id: "1749686", name: "Kalın Sigara Tabakası", tag: "Sigara Tabakası", note: "Sigarayı ve çakmağı birlikte taşıyan kapaklı tabaka", img: "/assets/cakmaklik-katalog/1749686.webp", url: "https://makerworld.com/tr/models/1749686-thick-cigarette-case" },
  { id: "3244736", name: "15 Gözlü Clipper Standı", tag: "Stand", note: "Tezgâh üstü 15 çakmaklık teşhir standı", img: "/assets/cakmaklik-katalog/3244736.webp", url: "https://makerworld.com/tr/models/3244736-custom-3d-printed-clipper-lighter-stand-15-slots" }
];

// Aynı katalog listesi sunucuda da kullanılır; istemciden gelen ürün adı veya
// kimliği körü körüne kabul edilmez.
if (typeof module !== "undefined" && module.exports) module.exports = LIGHTER_PRODUCTS;

if (typeof document !== "undefined") initKatalogSecim({
  prefix: "lighter",
  products: LIGHTER_PRODUCTS,
  endpoint: "/api/lighter-bulk-requests",
  minPerModel: 5,
  minTotal: 50,
  imageAltSuffix: "çakmaklığı"
});
