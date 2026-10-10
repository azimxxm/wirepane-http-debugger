import { buildSchema, introspectionFromSchema } from 'graphql';

// A small schema shaped like countries.trevorblades.com, the endpoint used to check GraphQL mode by hand
export const TEST_SDL = `
    "A country, with its ISO code"
    type Country {
        code: ID!
        name: String!
        capital: String
        currency: String
        continent: Continent!
        states: [State!]!
    }

    type Continent {
        code: ID!
        name: String!
        countries: [Country!]!
    }

    type State {
        code: String
        name: String!
        country: Country!
    }

    input StringQueryOperatorInput {
        eq: String
        in: [String!]
    }

    input CountryFilterInput {
        code: StringQueryOperatorInput
        currency: StringQueryOperatorInput
    }

    enum Region {
        EUROPE
        ASIA
        OCEANIA @deprecated(reason: "Split into smaller regions")
    }

    type Query {
        "All countries, optionally filtered"
        countries(filter: CountryFilterInput = {}): [Country!]!
        country(code: ID!): Country
        continents(region: Region): [Continent!]!
        countryCount: Int @deprecated(reason: "Count the countries instead")
    }
`;

export const testSchema = () => buildSchema(TEST_SDL);

// The JSON an endpoint with this schema answers to the introspection query
export const testIntrospectionBody = () => JSON.stringify({ data: introspectionFromSchema(testSchema()) });
