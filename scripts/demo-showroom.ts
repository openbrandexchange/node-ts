// The demo showroom (docs/demo.md): theme, login page and start page of the fictional fashion house
// MAISON NOOR, set at every reset from the seed archive (scripts/demo-seed.ts). Images are drawn by
// scripts/demo-art.ts; their ids are fixed so the settings can name them.

export const SHOWROOM_IMAGES = {
  hero: "img_noor_hero",
  login: "img_noor_login",
  knitwear: "img_noor_knitwear",
  outerwear: "img_noor_outerwear",
  bags: "img_noor_bags",
  shoes: "img_noor_shoes",
  materials: "img_noor_materials",
} as const;

const I = SHOWROOM_IMAGES;

export function showroomBranding() {
  return {
    theme: {
      color_scheme: "light",
      colors: { primary: "#1b1a19", secondary: "#8b7d6e", background: "#f6f3ee", surface: "#ffffff", text: "#1b1a19" },
      heading_font: "cormorant-garamond",
      body_font: "jost",
      radius: "none",
      grid_density: "editorial",
      card_style: "plain",
      image_fit: "contain",
      image_background: "#efece6",
    },
    login: {
      layout: "split",
      background_image: I.login,
      title: { en: "MAISON NOOR trade", nl: "MAISON NOOR trade" },
      text: {
        en: "Images, product data and line sheets for our stockists.",
        nl: "Beelden, productgegevens en linesheets voor onze verkooppunten.",
      },
    },
    home: {
      blocks: [
        {
          id: "hero",
          type: "hero",
          image: I.hero,
          title: { en: "Autumn/Winter 2026 — Quiet forms", nl: "Herfst/winter 2026 — Stille vormen" },
          text: {
            en: "Sculpted knitwear, fluid outerwear and leather pieces, made to outlast the season.",
            nl: "Gebeeldhouwd breiwerk, vloeiende jassen en leren stukken, gemaakt om het seizoen te overleven.",
          },
          button_label: { en: "View the collection", nl: "Bekijk de collectie" },
          link: "/catalog?season=AW26",
          align: "left",
          height: "large",
          overlay: "dark",
        },
        {
          id: "order-window",
          type: "announcement",
          text: {
            en: "Pre-orders for Spring/Summer 2027 are open until 15 January 2027. Lookbook images follow in December.",
            nl: "Voororders voor lente/zomer 2027 kunnen tot 15 januari 2027. De lookbookbeelden volgen in december.",
          },
          tone: "neutral",
        },
        {
          id: "categories",
          type: "tiles",
          title: { en: "The collection", nl: "De collectie" },
          columns: 4,
          items: [
            { image: I.knitwear, title: { en: "Knitwear", nl: "Breiwerk" }, link: "/catalog?item_type=sweater" },
            { image: I.outerwear, title: { en: "Outerwear", nl: "Jassen" }, link: "/catalog?item_type=jacket" },
            { image: I.bags, title: { en: "Bags", nl: "Tassen" }, link: "/catalog?item_type=bag&item_type=luggage" },
            { image: I.shoes, title: { en: "Shoes & accessories", nl: "Schoenen & accessoires" }, link: "/catalog?item_type=shoes&item_type=hat" },
          ],
        },
        {
          id: "new-this-season",
          type: "products",
          title: { en: "New this season", nl: "Nieuw dit seizoen" },
          query: "season=AW26",
          max: 8,
        },
        {
          id: "materials",
          type: "image_text",
          image: I.materials,
          image_side: "right",
          title: { en: "Organic and recycled, where it counts", nl: "Biologisch en gerecycled, waar het telt" },
          text: {
            en: "Our jersey is organic cotton, our technical pieces use recycled polyester and polyamide. Every fibre and its qualifiers are in the product data, ready for your shop.",
            nl: "Ons jersey is van biologisch katoen, onze technische stukken zijn van gerecycled polyester en polyamide. Elke vezel en de kenmerken ervan staan in de productgegevens, klaar voor je webshop.",
          },
          button_label: { en: "See organic pieces", nl: "Bekijk biologische stukken" },
          link: "/catalog?qualifier=organic",
        },
        {
          id: "the-house",
          type: "text",
          title: { en: "The house", nl: "Het huis" },
          body: {
            en: "MAISON NOOR is a fictional fashion house: womenswear, bags, shoes and accessories in a restrained palette.\n\nEverything in this demo portal is test data and is put back regularly. Try the downloads, the product data and the Excel export.",
            nl: "MAISON NOOR is een fictief modehuis: dameskleding, tassen, schoenen en accessoires in een ingetogen palet.\n\nAlles in deze demoportal is testdata en wordt regelmatig teruggezet. Probeer de downloads, de productgegevens en de Excel-export.",
          },
        },
        {
          id: "account-manager",
          type: "contact",
          title: { en: "Your account manager", nl: "Je accountmanager" },
          name: "Lina Verhoeven",
          email: "trade@maison-noor.example",
          phone: "+31 20 555 0187",
        },
      ],
    },
  };
}
