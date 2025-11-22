import { useUserStore } from "../store/useUserStore.js";

function Navbar(){
    const logout = useUserStore((s) => s.logout);

    return(
        <nav style = {{ padding: "10px", display : "flex", justifyContent: "space-between"}}>
            <h3>MarketHub</h3>
            <button onClick= {logout} style = {{padding : "5px 10px"}}>Logout</button>
        </nav>
    );
}

export default Navbar;