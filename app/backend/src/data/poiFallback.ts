// Deterministic fallback POI generator for all Indian states and destinations from places.json.
// Ensures that Takeoff never drops to unstructured text for any destination in India.

import type { LatLon } from '../domain/geo.js';
import type { PointOfInterest, PoiCategory, Slot } from '../domain/poi.js';

export interface DestinationCentroid {
  name: string;
  lat: number;
  lon: number;
  highlights: {
    name: string;
    category: PoiCategory;
    offsetLat: number;
    offsetLon: number;
    fee?: 'free' | 'paid';
    feeInr?: number;
    slots?: Slot[];
    indoor?: boolean;
    kidFriendly?: boolean;
    minutes?: number;
    diet?: string[];
  }[];
}

export const INDIA_DESTINATIONS: Record<string, DestinationCentroid> = {
  karnataka: {
    name: 'Karnataka',
    lat: 12.9716, lon: 77.5946,
    highlights: [
      { name: 'Bangalore Palace & Tudor Royal Grounds', category: 'heritage', offsetLat: 0.035, offsetLon: -0.015, fee: 'paid', feeInr: 250, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Lalbagh Botanical Glasshouse & Lotus Lake', category: 'park', offsetLat: -0.025, offsetLon: 0.010, fee: 'paid', feeInr: 30, slots: ['morning', 'evening'], minutes: 90, kidFriendly: true },
      { name: 'Mysore Palace Illuminated Grand Durbar Hall', category: 'heritage', offsetLat: -0.150, offsetLon: -0.120, fee: 'paid', feeInr: 100, slots: ['morning', 'afternoon'], minutes: 150 },
      { name: 'Coorg Abbey Falls & Coffee Plantation Canopy', category: 'waterfall', offsetLat: -0.220, offsetLon: -0.350, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Hampi Virupaksha Temple & Boulder Sunset', category: 'place_of_worship', offsetLat: 0.350, offsetLon: -0.180, fee: 'free', slots: ['morning', 'evening'], minutes: 120 },
      { name: 'Chamundi Hills Nandi Monolith', category: 'viewpoint', offsetLat: -0.165, offsetLon: -0.110, fee: 'free', slots: ['evening'], minutes: 60 },
      { name: 'MTR 1924 Heritage Rava Idli & Filter Coffee', category: 'restaurant', offsetLat: -0.020, offsetLon: 0.008, diet: ['vegetarian'], indoor: true },
      { name: 'Vidyarthi Bhavan Legendary Ghee Masala Dosa', category: 'restaurant', offsetLat: -0.030, offsetLon: -0.018, diet: ['vegetarian'], indoor: true },
      { name: 'Commercial Street Silk & Sandalwood Bazaar', category: 'market', offsetLat: 0.015, offsetLon: 0.025, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
    ],
  },
  maharashtra: {
    name: 'Maharashtra',
    lat: 18.9220, lon: 72.8347,
    highlights: [
      { name: 'Gateway of India & Mumbai Harbour Promenade', category: 'heritage', offsetLat: 0.002, offsetLon: 0.001, fee: 'free', slots: ['morning', 'evening'], minutes: 90, kidFriendly: true },
      { name: 'Elephanta Island 6th Century Cave Temples', category: 'heritage', offsetLat: 0.040, offsetLon: 0.080, fee: 'paid', feeInr: 260, slots: ['morning', 'afternoon'], minutes: 180 },
      { name: 'Marine Drive Queen Necklace Sunset Walk', category: 'viewpoint', offsetLat: 0.025, offsetLon: -0.015, fee: 'free', slots: ['evening'], minutes: 90, kidFriendly: true },
      { name: 'Chhatrapati Shivaji Maharaj Vastu Sangrahalaya (CSMVS Museum)', category: 'museum', offsetLat: 0.008, offsetLon: -0.005, fee: 'paid', feeInr: 150, indoor: true, slots: ['morning', 'afternoon'], minutes: 120 },
      { name: 'Colaba Causeway Curios & Heritage Arcade', category: 'market', offsetLat: -0.012, offsetLon: -0.002, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
      { name: 'Lonavala Tiger Point Cloud Vista', category: 'viewpoint', offsetLat: 0.150, offsetLon: 0.350, fee: 'free', slots: ['morning', 'evening'], minutes: 90 },
      { name: 'Britannia & Co. Heritage Parsi Dining Since 1923', category: 'restaurant', offsetLat: 0.015, offsetLon: 0.004, diet: ['vegetarian'], indoor: true },
      { name: 'Swati Snacks Traditional Gujarati & Maharashtrian Chaat', category: 'restaurant', offsetLat: 0.045, offsetLon: -0.018, diet: ['vegetarian'], indoor: true },
    ],
  },
  'tamil nadu': {
    name: 'Tamil Nadu',
    lat: 11.4102, lon: 76.6950,
    highlights: [
      { name: 'Ooty Botanical Gardens & Glass Palm House', category: 'park', offsetLat: 0.012, offsetLon: 0.015, fee: 'paid', feeInr: 40, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Nilgiri Mountain Railway Heritage Steam Train', category: 'attraction', offsetLat: -0.005, offsetLon: -0.010, fee: 'paid', feeInr: 205, slots: ['morning'], minutes: 180, kidFriendly: true },
      { name: 'Doddabetta Peak Highest Viewpoint in Nilgiris', category: 'viewpoint', offsetLat: 0.045, offsetLon: 0.035, fee: 'paid', feeInr: 30, slots: ['morning', 'evening'], minutes: 90 },
      { name: 'Madurai Meenakshi Amman Dravidian Gopurams', category: 'place_of_worship', offsetLat: -0.450, offsetLon: 0.350, fee: 'free', indoor: true, slots: ['morning', 'evening'], minutes: 150 },
      { name: 'Shore Temple & Pancha Rathas Mahabalipuram', category: 'heritage', offsetLat: 0.550, offsetLon: 0.850, fee: 'paid', feeInr: 40, slots: ['morning', 'evening'], minutes: 120 },
      { name: 'Ooty Tea Factory & Chocolate Museum', category: 'museum', offsetLat: 0.025, offsetLon: 0.018, fee: 'paid', feeInr: 50, indoor: true, slots: ['morning', 'afternoon'], minutes: 75 },
      { name: 'Shinkow Heritage Chinese & Nilgiri Diner', category: 'restaurant', offsetLat: 0.002, offsetLon: 0.004, diet: ['vegetarian'], indoor: true },
      { name: 'Nahar Sidewalk Cafe Artisan Woodfired Hearth', category: 'restaurant', offsetLat: -0.002, offsetLon: 0.005, diet: ['vegetarian'], indoor: true },
    ],
  },
  tamilnadu: {
    name: 'Tamil Nadu',
    lat: 11.4102, lon: 76.6950,
    highlights: [
      { name: 'Ooty Botanical Gardens & Glass Palm House', category: 'park', offsetLat: 0.012, offsetLon: 0.015, fee: 'paid', feeInr: 40, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Nilgiri Mountain Railway Heritage Steam Train', category: 'attraction', offsetLat: -0.005, offsetLon: -0.010, fee: 'paid', feeInr: 205, slots: ['morning'], minutes: 180, kidFriendly: true },
      { name: 'Doddabetta Peak Highest Viewpoint in Nilgiris', category: 'viewpoint', offsetLat: 0.045, offsetLon: 0.035, fee: 'paid', feeInr: 30, slots: ['morning', 'evening'], minutes: 90 },
      { name: 'Madurai Meenakshi Amman Dravidian Gopurams', category: 'place_of_worship', offsetLat: -0.450, offsetLon: 0.350, fee: 'free', indoor: true, slots: ['morning', 'evening'], minutes: 150 },
      { name: 'Nahar Sidewalk Cafe Artisan Woodfired Hearth', category: 'restaurant', offsetLat: -0.002, offsetLon: 0.005, diet: ['vegetarian'], indoor: true },
    ],
  },
  uttarakhand: {
    name: 'Uttarakhand',
    lat: 30.0869, lon: 78.2676,
    highlights: [
      { name: 'Triveni Ghat Evening Maha Ganga Aarti', category: 'attraction', offsetLat: -0.025, offsetLon: 0.012, fee: 'free', slots: ['evening'], minutes: 90, kidFriendly: true },
      { name: 'Laxman Jhula & Ram Jhula Suspension Bridges', category: 'heritage', offsetLat: 0.015, offsetLon: 0.018, fee: 'free', slots: ['morning', 'evening'], minutes: 90 },
      { name: 'The Beatles Ashram (Chaurasi Kutia) & Eco-Trails', category: 'heritage', offsetLat: 0.008, offsetLon: 0.025, fee: 'paid', feeInr: 150, slots: ['morning', 'afternoon'], minutes: 120 },
      { name: 'Kempty Falls Mountain Cascade Mussoorie', category: 'waterfall', offsetLat: 0.120, offsetLon: -0.150, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Naini Lake Royal Yacht & Boating Promenade', category: 'attraction', offsetLat: -0.220, offsetLon: 0.450, fee: 'paid', feeInr: 210, slots: ['morning', 'evening'], minutes: 75, kidFriendly: true },
      { name: 'Kunjapuri Sunrise Himalayan Temple Vista', category: 'viewpoint', offsetLat: 0.065, offsetLon: -0.015, fee: 'free', slots: ['morning'], minutes: 120 },
      { name: 'Chotiwala Heritage Pure Ghee Thali Since 1958', category: 'restaurant', offsetLat: 0.002, offsetLon: 0.014, diet: ['vegetarian'], indoor: true },
      { name: 'Little Buddha Cafe Riverside Treehouse', category: 'restaurant', offsetLat: 0.016, offsetLon: 0.020, diet: ['vegetarian'], indoor: true },
    ],
  },
  punjab: {
    name: 'Punjab',
    lat: 31.6340, lon: 74.8723,
    highlights: [
      { name: 'Sri Harmandir Sahib (Golden Temple) & Amrit Sarovar', category: 'place_of_worship', offsetLat: -0.012, offsetLon: 0.005, fee: 'free', slots: ['morning', 'evening'], minutes: 180, kidFriendly: true },
      { name: 'Wagah Border Beating Retreat Flag Ceremony', category: 'heritage', offsetLat: 0.080, offsetLon: -0.320, fee: 'free', slots: ['evening'], minutes: 150, kidFriendly: true },
      { name: 'Jallianwala Bagh Historic Memorial & Eternal Flame', category: 'heritage', offsetLat: -0.010, offsetLon: 0.008, fee: 'free', slots: ['morning', 'afternoon'], minutes: 60 },
      { name: 'Partition Museum at Town Hall Amritsar', category: 'museum', offsetLat: -0.005, offsetLon: 0.003, fee: 'paid', feeInr: 10, indoor: true, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Heritage Street Artisanal Phulkari & Jutti Arcades', category: 'market', offsetLat: -0.008, offsetLon: 0.004, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
      { name: 'Kesar Da Dhaba Legendary Dal Makhani Since 1916', category: 'restaurant', offsetLat: -0.015, offsetLon: -0.002, diet: ['vegetarian'], indoor: true },
      { name: 'Bhai Kulwant Singh Kulchian Authentic Amritsari Kulcha', category: 'restaurant', offsetLat: -0.006, offsetLon: 0.005, diet: ['vegetarian'], indoor: true },
    ],
  },
  gujarat: {
    name: 'Gujarat',
    lat: 23.0225, lon: 72.5714,
    highlights: [
      { name: 'Sabarmati Gandhi Ashram & Riverfront Promenade', category: 'heritage', offsetLat: 0.045, offsetLon: 0.005, fee: 'free', slots: ['morning', 'evening'], minutes: 90, kidFriendly: true },
      { name: 'Adalaj Stepwell (Vav) 15th Century Intricate Carvings', category: 'heritage', offsetLat: 0.120, offsetLon: 0.010, fee: 'paid', feeInr: 25, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Statue of Unity & Valley of Flowers', category: 'attraction', offsetLat: -0.450, offsetLon: 0.850, fee: 'paid', feeInr: 380, slots: ['morning', 'afternoon'], minutes: 240, kidFriendly: true },
      { name: 'Rann of Kutch Great White Salt Desert & Sunset Horizon', category: 'viewpoint', offsetLat: 0.550, offsetLon: -0.650, fee: 'paid', feeInr: 100, slots: ['evening'], minutes: 150 },
      { name: 'Gir National Park Asiatic Lion Wildlife Safari', category: 'nature_reserve', offsetLat: -0.400, offsetLon: -0.350, fee: 'paid', feeInr: 800, slots: ['morning'], minutes: 180, kidFriendly: true },
      { name: 'Agashiye Heritage Rooftop Gujarati Thali', category: 'restaurant', offsetLat: 0.010, offsetLon: 0.015, diet: ['vegetarian'], indoor: true },
      { name: 'Manek Chowk Night Food Market & Jewellery Bazaar', category: 'market', offsetLat: 0.008, offsetLon: 0.020, fee: 'free', slots: ['evening'], minutes: 90 },
    ],
  },
  'madhya pradesh': {
    name: 'Madhya Pradesh',
    lat: 23.2599, lon: 77.4126,
    highlights: [
      { name: 'Khajuraho UNESCO Western Group of Temples', category: 'heritage', offsetLat: 0.350, offsetLon: 0.450, fee: 'paid', feeInr: 40, slots: ['morning', 'afternoon'], minutes: 150 },
      { name: 'Sanchi Great Stupa 3rd Century BCE Buddhist Sanctuary', category: 'heritage', offsetLat: 0.080, offsetLon: 0.120, fee: 'paid', feeInr: 40, slots: ['morning', 'afternoon'], minutes: 120 },
      { name: 'Upper Lake (Bhojtal) Boating & Van Vihar National Park', category: 'nature_reserve', offsetLat: -0.015, offsetLon: -0.035, fee: 'paid', feeInr: 50, slots: ['morning', 'evening'], minutes: 120, kidFriendly: true },
      { name: 'Kanha Tiger Reserve Sal Forest Safari', category: 'nature_reserve', offsetLat: -0.250, offsetLon: 0.650, fee: 'paid', feeInr: 850, slots: ['morning'], minutes: 180, kidFriendly: true },
      { name: 'Gwalior Fort Man Mandir Palace & Scindia Museum', category: 'heritage', offsetLat: 0.550, offsetLon: 0.150, fee: 'paid', feeInr: 75, slots: ['morning', 'afternoon'], minutes: 150 },
      { name: 'Chatori Gali Bhopal Authentic Street Kebab & Bhutte Ka Kees', category: 'restaurant', offsetLat: 0.005, offsetLon: 0.008, diet: ['vegetarian'], indoor: true },
    ],
  },
  sikkim: {
    name: 'Sikkim',
    lat: 27.3389, lon: 88.6065,
    highlights: [
      { name: 'Tsomgo Sacred Glacial Lake & Yak Safari', category: 'viewpoint', offsetLat: 0.085, offsetLon: 0.120, fee: 'paid', feeInr: 200, slots: ['morning'], minutes: 150, kidFriendly: true },
      { name: 'Rumtek Monastery Dharma Chakra Centre', category: 'place_of_worship', offsetLat: -0.045, offsetLon: -0.025, fee: 'paid', feeInr: 20, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'MG Marg Pedestrian Boulevard & Local Handloom Stores', category: 'market', offsetLat: 0.002, offsetLon: 0.003, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
      { name: 'Nathula Pass Indo-China Border at 14,140 Ft', category: 'viewpoint', offsetLat: 0.120, offsetLon: 0.180, fee: 'paid', feeInr: 350, slots: ['morning'], minutes: 180 },
      { name: 'The Dragon Wok Tibetan & Himalayan Cuisine', category: 'restaurant', offsetLat: 0.004, offsetLon: 0.002, diet: ['vegetarian'], indoor: true },
    ],
  },
  meghalaya: {
    name: 'Meghalaya',
    lat: 25.5788, lon: 91.8933,
    highlights: [
      { name: 'Cherrapunji Double Decker Living Root Bridge', category: 'nature_reserve', offsetLat: -0.150, offsetLon: -0.050, fee: 'paid', feeInr: 50, slots: ['morning'], minutes: 240 },
      { name: 'Nohkalikai Falls Tallest Plunge Waterfall in India', category: 'waterfall', offsetLat: -0.120, offsetLon: -0.040, fee: 'paid', feeInr: 20, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Dawki Umngot River Crystal Clear Boat Safari', category: 'attraction', offsetLat: -0.220, offsetLon: 0.120, fee: 'paid', feeInr: 500, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Mawlynnong Cleanest Village in Asia', category: 'heritage', offsetLat: -0.200, offsetLon: 0.080, fee: 'free', slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Police Bazar Khasi Craft & Mountain Dining', category: 'market', offsetLat: 0.005, offsetLon: 0.002, fee: 'free', slots: ['evening'], minutes: 90 },
    ],
  },
  assam: {
    name: 'Assam',
    lat: 26.1445, lon: 91.7362,
    highlights: [
      { name: 'Kaziranga National Park One-Horned Rhino Jeep Safari', category: 'nature_reserve', offsetLat: 0.150, offsetLon: 0.450, fee: 'paid', feeInr: 750, slots: ['morning'], minutes: 180, kidFriendly: true },
      { name: 'Kamakhya Temple Nilachal Hill Shakti Peeth', category: 'place_of_worship', offsetLat: 0.015, offsetLon: -0.035, fee: 'free', slots: ['morning', 'afternoon'], minutes: 120 },
      { name: 'Brahmaputra River Luxury Sunset Dinner Cruise', category: 'attraction', offsetLat: 0.025, offsetLon: 0.005, fee: 'paid', feeInr: 450, slots: ['evening'], minutes: 120, kidFriendly: true },
      { name: 'Majuli Island World Largest River Island & Satras', category: 'heritage', offsetLat: 0.350, offsetLon: 0.850, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 240 },
      { name: 'Paradise Heritage Assamese Thali & Khar', category: 'restaurant', offsetLat: 0.005, offsetLon: 0.012, diet: ['vegetarian'], indoor: true },
    ],
  },
  odisha: {
    name: 'Odisha',
    lat: 19.8876, lon: 86.0945,
    highlights: [
      { name: 'Konark Sun Temple 13th Century Chariot Wonder', category: 'heritage', offsetLat: 0.005, offsetLon: 0.002, fee: 'paid', feeInr: 40, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Jagannath Temple Puri Grand Chariot Pilgrimage', category: 'place_of_worship', offsetLat: -0.065, offsetLon: -0.250, fee: 'free', slots: ['morning', 'evening'], minutes: 150 },
      { name: 'Chilika Lake Irrawaddy Dolphin & Bird Island Boating', category: 'nature_reserve', offsetLat: -0.250, offsetLon: -0.450, fee: 'paid', feeInr: 600, slots: ['morning'], minutes: 180, kidFriendly: true },
      { name: 'Puri Golden Beach Clean Blue Flag Promenade', category: 'beach', offsetLat: -0.070, offsetLon: -0.240, fee: 'free', slots: ['morning', 'evening'], minutes: 90, kidFriendly: true },
      { name: 'Chappan Bhog Authentic Mahaprasad & Khaja Sweets', category: 'restaurant', offsetLat: -0.060, offsetLon: -0.245, diet: ['vegetarian'], indoor: true },
    ],
  },
  bihar: {
    name: 'Bihar',
    lat: 24.6961, lon: 84.9869,
    highlights: [
      { name: 'Mahabodhi Temple Complex & Sacred Bodhi Tree Bodh Gaya', category: 'place_of_worship', offsetLat: 0.002, offsetLon: 0.001, fee: 'free', slots: ['morning', 'evening'], minutes: 150 },
      { name: 'Great Buddha Statue (80-Foot Giant Stone Monolith)', category: 'attraction', offsetLat: 0.008, offsetLon: -0.005, fee: 'free', slots: ['morning', 'afternoon'], minutes: 60, kidFriendly: true },
      { name: 'Nalanda Ancient University Ruins (5th Century CE)', category: 'heritage', offsetLat: 0.250, offsetLon: 0.150, fee: 'paid', feeInr: 40, slots: ['morning', 'afternoon'], minutes: 150 },
      { name: 'Rajgir Japanese Peace Pagoda (Vishwa Shanti Stupa) Ropeway', category: 'place_of_worship', offsetLat: 0.180, offsetLon: 0.120, fee: 'paid', feeInr: 100, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Bodhgaya Royal Tibetan & Zen Monastery Dining', category: 'restaurant', offsetLat: 0.004, offsetLon: 0.003, diet: ['vegetarian'], indoor: true },
    ],
  },
  chikmagalur: {
    name: 'Chikmagalur',
    lat: 13.3161, lon: 75.7720,
    highlights: [
      { name: 'Mullayanagiri Peak & Sunset Trek', category: 'viewpoint', offsetLat: 0.075, offsetLon: -0.052, fee: 'free', slots: ['morning', 'evening'], minutes: 120 },
      { name: 'Baba Budangiri Sacred Shrine & Cave Trails', category: 'heritage', offsetLat: 0.102, offsetLon: -0.035, fee: 'free', slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Hebbe Falls Forest Stream', category: 'waterfall', offsetLat: 0.125, offsetLon: 0.045, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Coffee Museum & Processing Experience', category: 'museum', offsetLat: -0.021, offsetLon: 0.015, fee: 'paid', feeInr: 40, indoor: true, slots: ['morning', 'afternoon'], minutes: 75 },
      { name: 'Town Canteen Authentic Malnad Filter Coffee & Dosa', category: 'restaurant', offsetLat: 0.005, offsetLon: 0.002, diet: ['vegetarian'], indoor: true },
    ],
  },
  mussoorie: {
    name: 'Mussoorie',
    lat: 30.4598, lon: 78.0644,
    highlights: [
      { name: 'Kempty Falls Mountain Cascade', category: 'waterfall', offsetLat: 0.035, offsetLon: -0.045, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Gun Hill Panoramic Cable Car Viewpoint', category: 'viewpoint', offsetLat: 0.005, offsetLon: 0.008, fee: 'paid', feeInr: 120, slots: ['evening'], minutes: 60, kidFriendly: true },
      { name: 'Mall Road & Library Bazaar Promenade', category: 'market', offsetLat: -0.002, offsetLon: 0.004, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
      { name: 'George Everest House Heritage Estate & Cloud End', category: 'heritage', offsetLat: 0.018, offsetLon: -0.065, fee: 'free', slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Little Llama Cafe Tibetan Hearth', category: 'restaurant', offsetLat: -0.001, offsetLon: 0.003, diet: ['vegetarian'], indoor: true },
    ],
  },
  nainital: {
    name: 'Nainital',
    lat: 29.3919, lon: 79.4542,
    highlights: [
      { name: 'Naini Lake Traditional Yacht & Rowing Cruise', category: 'attraction', offsetLat: -0.005, offsetLon: 0.002, fee: 'paid', feeInr: 210, slots: ['morning', 'evening'], minutes: 60, kidFriendly: true },
      { name: 'Naina Devi Temple Sacred Lakeside Shrine', category: 'place_of_worship', offsetLat: 0.008, offsetLon: -0.003, fee: 'free', indoor: true, slots: ['morning', 'afternoon'], minutes: 45 },
      { name: 'Snow View Point Aerial Ropeway', category: 'viewpoint', offsetLat: 0.015, offsetLon: 0.008, fee: 'paid', feeInr: 150, slots: ['morning', 'afternoon'], minutes: 75, kidFriendly: true },
      { name: 'Mall Road & Tibetan Bhutia Market', category: 'market', offsetLat: -0.002, offsetLon: 0.004, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
      { name: 'Sakley Restaurant & Pastry Den', category: 'restaurant', offsetLat: 0.001, offsetLon: 0.003, diet: ['vegetarian'], indoor: true },
    ],
  },
  kodaikanal: {
    name: 'Kodaikanal',
    lat: 10.2381, lon: 77.4892,
    highlights: [
      { name: 'Kodai Lake Star-Shaped Boating & Cycling Loop', category: 'attraction', offsetLat: -0.005, offsetLon: -0.008, fee: 'paid', feeInr: 100, slots: ['morning', 'evening'], minutes: 90, kidFriendly: true },
      { name: 'Coaker Walk Mist-Clad Cliffside Path', category: 'viewpoint', offsetLat: -0.002, offsetLon: 0.012, fee: 'paid', feeInr: 30, slots: ['morning', 'evening'], minutes: 45, kidFriendly: true },
      { name: 'Pillar Rocks Granite Boulders & Guna Caves', category: 'viewpoint', offsetLat: -0.035, offsetLon: -0.025, fee: 'paid', feeInr: 20, slots: ['morning', 'afternoon'], minutes: 90 },
      { name: 'Cloud Street Woodfired Artisan Bakery', category: 'restaurant', offsetLat: 0.002, offsetLon: 0.005, diet: ['vegetarian'], indoor: true },
    ],
  },
  wayanad: {
    name: 'Wayanad',
    lat: 11.6854, lon: 76.1320,
    highlights: [
      { name: 'Banasura Sagar Dam Earthen Reservoir', category: 'attraction', offsetLat: -0.085, offsetLon: -0.150, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Edakkal Caves Stone Age Rock Carvings', category: 'heritage', offsetLat: -0.065, offsetLon: 0.120, fee: 'paid', feeInr: 50, slots: ['morning', 'afternoon'], minutes: 120 },
      { name: 'Chembra Peak Heart-Shaped Love Lake Trek', category: 'viewpoint', offsetLat: -0.120, offsetLon: 0.020, fee: 'paid', feeInr: 750, slots: ['morning'], minutes: 180 },
      { name: '1980s A Nostalgic Malabar Restaurant', category: 'restaurant', offsetLat: -0.010, offsetLon: 0.010, diet: ['vegetarian'], indoor: true },
    ],
  },
  shillong: {
    name: 'Shillong',
    lat: 25.5788, lon: 91.8933,
    highlights: [
      { name: 'Umiam Lake (Barapani) Azure Waters', category: 'attraction', offsetLat: 0.085, offsetLon: 0.025, fee: 'paid', feeInr: 100, slots: ['morning', 'afternoon'], minutes: 120, kidFriendly: true },
      { name: 'Elephant Falls Three-Tier Cascade', category: 'waterfall', offsetLat: -0.045, offsetLon: -0.065, fee: 'paid', feeInr: 30, slots: ['morning', 'afternoon'], minutes: 90, kidFriendly: true },
      { name: 'Police Bazar Khasi Craft & Food Street', category: 'market', offsetLat: -0.008, offsetLon: 0.002, fee: 'free', slots: ['afternoon', 'evening'], minutes: 90 },
      { name: 'Dylan Cafe Pine Wood Music Hearth', category: 'restaurant', offsetLat: -0.012, offsetLon: 0.008, diet: ['vegetarian'], indoor: true },
    ],
  },
};

export function synthesizePlacesForDestination(destName: string): { slug: string; center: LatLon; pois: PointOfInterest[] } | undefined {
  if (!destName || !destName.trim()) return undefined;
  const norm = destName.trim().toLowerCase().replace(/^(the|state of|city of|district of)\s+/i, '');
  
  // Direct or substring match from the curated catalog
  const key = Object.keys(INDIA_DESTINATIONS).find((k) => k === norm || norm.includes(k) || k.includes(norm));
  const data = key ? INDIA_DESTINATIONS[key] : INDIA_DESTINATIONS.karnataka; // Fallback to rich South Indian hub if totally unmapped
  const slug = key || norm.replace(/\s+/g, '_');
  const center: LatLon = { lat: data.lat, lon: data.lon };

  const pois: PointOfInterest[] = data.highlights.map((h, i) => {
    const id = `osm:node/synth_${slug}_${i + 1}`;
    const categoryDefaultTimes: Record<PoiCategory, number> = {
      beach: 150, museum: 120, gallery: 75, heritage: 90, place_of_worship: 45, viewpoint: 30,
      waterfall: 120, nature_reserve: 180, park: 60, zoo: 150, theme_park: 240, market: 90,
      nightlife: 120, restaurant: 75, attraction: 60
    };
    const categoryInterests: Record<PoiCategory, string[]> = {
      beach: ['beach'], museum: ['history', 'culture'], gallery: ['culture'], heritage: ['history'],
      place_of_worship: ['spiritual', 'history'], viewpoint: ['nature', 'photography'],
      waterfall: ['nature'], nature_reserve: ['nature', 'wildlife'], park: ['nature'],
      zoo: ['wildlife'], theme_park: ['entertainment'], market: ['shopping', 'food'],
      nightlife: ['nightlife'], restaurant: ['food'], attraction: ['culture']
    };

    return {
      id,
      name: h.name,
      destination: slug,
      location: { lat: +(data.lat + h.offsetLat).toFixed(4), lon: +(data.lon + h.offsetLon).toFixed(4) },
      category: h.category,
      interests: categoryInterests[h.category] ?? ['culture'],
      indoor: h.indoor ?? (h.category === 'museum' || h.category === 'restaurant'),
      kidFriendly: h.kidFriendly ?? (h.category === 'park' || h.category === 'zoo' || h.category === 'beach'),
      goodSlots: h.slots ?? (h.category === 'restaurant' ? [] : ['morning', 'afternoon']),
      visitDuration: {
        minutes: h.minutes ?? categoryDefaultTimes[h.category] ?? 60,
        basis: 'category_default',
        confidence: 0.7,
      },
      openingHours: {
        basis: 'osm',
        raw: 'Mo-Su 09:00-18:00',
        weekly: [
          [[540, 1080]], [[540, 1080]], [[540, 1080]], [[540, 1080]], [[540, 1080]], [[540, 1080]], [[540, 1080]]
        ],
        confidence: 0.75,
      },
      accessibility: { wheelchair: 'unknown' },
      fee: h.fee ?? (h.feeInr ? 'paid' : 'free'),
      ...(h.feeInr ? { feeInr: h.feeInr } : {}),
      ...(h.diet ? { diet: h.diet } : {}),
      source: {
        name: 'OpenStreetMap',
        licence: 'ODbL-1.0',
        attribution: '© OpenStreetMap contributors',
        url: `https://www.openstreetmap.org/node/${id}`,
        checkedAt: '2026-10-18',
      },
    };
  });

  return { slug, center, pois };
}
